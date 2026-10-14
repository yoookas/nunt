package forward

import (
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
)

// halfCloser is implemented by *net.TCPConn and allows the read direction to
// be shut down without tearing the whole connection down.
type halfCloser interface {
	CloseWrite() error
}

// proxy is one concrete listener; a rule uses one proxy per protocol.
type proxy struct {
	f           *Forward
	rule        model.ForwardRule
	proto       string
	fingerprint string

	mu       sync.Mutex
	closed   bool
	waited   bool
	ln       net.Listener   // TCP
	pc       net.PacketConn // UDP
	sessions map[string]*udpSession
	lastErr  error

	conns   map[net.Conn]struct{}
	connMu  sync.Mutex
	pending sync.WaitGroup
	wg      sync.WaitGroup

	// limitMu guards connPerIP, the per client address counter of the admitted
	// TCP connections; sessPerIP is the same counter for the UDP sessions and is
	// guarded by mu, which already owns the session table.
	limitMu   sync.Mutex
	connPerIP map[string]int
	sessPerIP map[string]int

	active    atomic.Int64
	total     atomic.Uint64
	upBytes   atomic.Uint64
	downBytes atomic.Uint64
	// rejectedRule and rejectedIP count the connections refused by the
	// concurrency limits of the rule.
	rejectedRule atomic.Uint64
	rejectedIP   atomic.Uint64
}

func newProxy(f *Forward, r model.ForwardRule) *proxy {
	return &proxy{
		f:           f,
		rule:        r,
		proto:       protoTCP,
		fingerprint: fingerprint(r),
		sessions:    map[string]*udpSession{},
		conns:       map[net.Conn]struct{}{},
		connPerIP:   map[string]int{},
		sessPerIP:   map[string]int{},
	}
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

// start binds the socket of the proxy protocol and spawns the serving
// goroutines. It never panics: a busy port is reported as an error and the
// rule is simply marked as not listening.
func (p *proxy) start() error {
	protocol := protoTCP
	if protos := protoList(p.rule.Protocol); len(protos) > 0 {
		protocol = protos[0]
	}
	p.proto = protocol
	addr := listenAddr(p.rule.SrcAddr)

	if protocol == protoUDP {
		pc, err := net.ListenPacket(protoUDP, addr)
		if err != nil {
			p.setError(err)
			return fmt.Errorf("listen udp on %s: %w", addr, err)
		}
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			_ = pc.Close()
			return fmt.Errorf("rule %s was stopped while starting", ruleLabel(p.rule))
		}
		p.pc = pc
		p.lastErr = nil
		p.mu.Unlock()

		p.wg.Add(2)
		go p.udpReadLoop(pc)
		go p.udpSweepLoop()
		p.logStarted(addr)
		return nil
	}

	ln, err := net.Listen(protoTCP, addr)
	if err != nil {
		p.setError(err)
		return fmt.Errorf("listen tcp on %s: %w", addr, err)
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		_ = ln.Close()
		return fmt.Errorf("rule %s was stopped while starting", ruleLabel(p.rule))
	}
	p.ln = ln
	p.lastErr = nil
	p.mu.Unlock()

	p.wg.Add(1)
	go p.acceptLoop(ln)
	p.logStarted(addr)
	return nil
}

func (p *proxy) logStarted(addr string) {
	p.f.log.Info("forward: rule listening",
		"rule", ruleLabel(p.rule), "protocol", p.proto, "src", addr, "dst", p.rule.DstAddr)
}

// close stops the listener and every relayed connection. It never blocks, so
// it is safe to call from inside a configuration update.
func (p *proxy) close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	ln := p.ln
	pc := p.pc
	p.ln = nil
	p.pc = nil
	sessions := make([]*udpSession, 0, len(p.sessions))
	for key, s := range p.sessions {
		delete(p.sessions, key)
		sessions = append(sessions, s)
	}
	p.sessions = map[string]*udpSession{}
	p.sessPerIP = map[string]int{}
	p.mu.Unlock()

	if ln != nil {
		// Closing a listener without a deadline may block for a keep alive
		// period; the short deadline makes the accept loop return promptly.
		if tl, ok := ln.(*net.TCPListener); ok {
			_ = tl.SetDeadline(time.Now().Add(time.Second))
		}
		_ = ln.Close()
	}
	if pc != nil {
		_ = pc.Close()
	}
	p.closeConns()
	for _, s := range sessions {
		s.close()
	}
	p.f.log.Info("forward: rule stopped", "rule", ruleLabel(p.rule), "protocol", p.proto)
}

func (p *proxy) closeConns() {
	p.connMu.Lock()
	conns := make([]net.Conn, 0, len(p.conns))
	for c := range p.conns {
		conns = append(conns, c)
	}
	p.conns = map[net.Conn]struct{}{}
	p.connMu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

// wait blocks until every goroutine of the proxy has returned. It is a no-op
// after the first call and must only be used after close.
func (p *proxy) wait() {
	p.mu.Lock()
	if p.waited {
		p.mu.Unlock()
		return
	}
	p.waited = true
	p.mu.Unlock()
	p.wg.Wait()
}

func (p *proxy) isRunning() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return false
	}
	return p.ln != nil || p.pc != nil
}

func (p *proxy) setError(err error) {
	p.mu.Lock()
	p.lastErr = err
	p.mu.Unlock()
}

// err returns the reason the listener could not be started, if any.
func (p *proxy) err() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lastErr
}

func (p *proxy) addConn(c net.Conn) bool {
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return false
	}
	p.connMu.Lock()
	defer p.connMu.Unlock()
	p.conns[c] = struct{}{}
	return true
}

func (p *proxy) dropConn(c net.Conn) {
	p.connMu.Lock()
	delete(p.conns, c)
	p.connMu.Unlock()
}

// ---------------------------------------------------------------------------
// TCP
// ---------------------------------------------------------------------------

func (p *proxy) acceptLoop(ln net.Listener) {
	defer p.wg.Done()
	for {
		if tl, ok := ln.(*net.TCPListener); ok {
			_ = tl.SetDeadline(time.Now().Add(closeGrace))
		}
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				if !p.isRunning() {
					return
				}
				continue
			}
			p.f.log.Warn("forward: accept failed", "rule", ruleLabel(p.rule), "error", err)
			if !p.isRunning() {
				return
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		if !p.addConn(conn) {
			_ = conn.Close()
			return
		}
		// The concurrency limits are applied before a relay goroutine is
		// spawned: an abusive client must not be able to allocate one.
		ip := clientIPKey(conn.RemoteAddr())
		if reason, admitted := p.admit(ip); !admitted {
			_ = conn.Close()
			p.dropConn(conn)
			p.reject(reason, conn.RemoteAddr())
			continue
		}
		p.pending.Add(1)
		go p.handleTCP(conn, ip)
	}
}

// admit reserves a connection slot of the rule for a client address. It returns
// the refusal reason, which is empty when the connection is accepted; release
// must be called exactly once for every accepted connection.
func (p *proxy) admit(ip string) (string, bool) {
	limit, perIP := maxConns(p.rule), maxConnsPerIP(p.rule)
	p.limitMu.Lock()
	defer p.limitMu.Unlock()
	if limit > 0 && int(p.active.Load()) >= limit {
		return reasonRuleLimit, false
	}
	if perIP > 0 && ip != "" && p.connPerIP[ip] >= perIP {
		return reasonIPLimit, false
	}
	if ip != "" {
		p.connPerIP[ip]++
	}
	p.active.Add(1)
	return "", true
}

// release gives back the slot of an admitted connection.
func (p *proxy) release(ip string) {
	p.limitMu.Lock()
	if ip != "" {
		switch n := p.connPerIP[ip]; {
		case n <= 1:
			delete(p.connPerIP, ip)
		default:
			p.connPerIP[ip] = n - 1
		}
	}
	p.limitMu.Unlock()
	p.active.Add(-1)
}

// reject records and counts a TCP connection refused by a concurrency limit.
func (p *proxy) reject(reason string, remote net.Addr) {
	p.countRejection(reason)
	p.record(accessEntry{
		Time:     time.Now(),
		RuleID:   p.rule.ID,
		Rule:     ruleLabel(p.rule),
		Protocol: protoTCP,
		Client:   addrString(remote),
		Target:   p.rule.DstAddr,
		Result:   "rejected: " + reason,
	})
	p.f.log.Warn("forward: connection rejected by a concurrency limit",
		"rule", ruleLabel(p.rule), "protocol", p.proto, "client", addrString(remote),
		"reason", reason, "limit", p.limitValue(reason))
}

// countRejection bumps the counter of one limit.
func (p *proxy) countRejection(reason string) {
	if reason == reasonIPLimit {
		p.rejectedIP.Add(1)
		return
	}
	p.rejectedRule.Add(1)
}

// limitValue returns the cap that caused a refusal, for logging.
func (p *proxy) limitValue(reason string) int {
	if reason == reasonIPLimit {
		return maxConnsPerIP(p.rule)
	}
	return maxConns(p.rule)
}

func (p *proxy) handleTCP(src net.Conn, ip string) {
	defer p.pending.Done()
	defer p.dropConn(src)
	defer func() { _ = src.Close() }()
	// The slot was reserved by the accept loop before this goroutine existed.
	defer p.release(ip)

	start := time.Now()
	client := addrString(src.RemoteAddr())

	if !p.allow(src.RemoteAddr()) {
		p.record(accessEntry{
			Time:     start,
			RuleID:   p.rule.ID,
			Rule:     ruleLabel(p.rule),
			Protocol: protoTCP,
			Client:   client,
			Target:   p.rule.DstAddr,
			Result:   "denied",
			Duration: time.Since(start),
		})
		p.f.log.Warn("forward: connection denied by the access rule",
			"rule", ruleLabel(p.rule), "client", client)
		return
	}

	p.total.Add(1)

	dialer := net.Dialer{Timeout: dialTimeout}
	dst, err := dialer.Dial(protoTCP, p.rule.DstAddr)
	if err != nil {
		p.record(accessEntry{
			Time:     start,
			RuleID:   p.rule.ID,
			Rule:     ruleLabel(p.rule),
			Protocol: protoTCP,
			Client:   client,
			Target:   p.rule.DstAddr,
			Result:   "failed: " + err.Error(),
			Duration: time.Since(start),
		})
		p.f.log.Warn("forward: cannot reach the destination",
			"rule", ruleLabel(p.rule), "dst", p.rule.DstAddr, "error", err)
		return
	}
	defer func() { _ = dst.Close() }()

	up, down := p.relay(src, dst, timeoutSeconds(p.rule))
	p.record(accessEntry{
		Time:     start,
		RuleID:   p.rule.ID,
		Rule:     ruleLabel(p.rule),
		Protocol: protoTCP,
		Client:   client,
		Target:   p.rule.DstAddr,
		Result:   "closed",
		Duration: time.Since(start),
		BytesIn:  up,
		BytesOut: down,
	})
}

// relay pumps bytes in both directions until one side is done, applying an
// idle timeout and a half close so that protocols such as HTTP/1.1 or SMTP
// observe a clean shutdown.
func (p *proxy) relay(src, dst net.Conn, timeoutSec int) (int64, int64) {
	timeout := time.Duration(timeoutSec) * time.Second

	var once sync.Once
	shutdown := func() {
		once.Do(func() {
			_ = src.Close()
			_ = dst.Close()
		})
	}
	timer := time.AfterFunc(timeout, shutdown)
	touch := func() {
		now := time.Now()
		_ = src.SetDeadline(now.Add(timeout))
		_ = dst.SetDeadline(now.Add(timeout))
		timer.Reset(timeout)
	}
	touch()

	upCh := make(chan int64, 1)
	downCh := make(chan int64, 1)
	publish := func(ch chan int64, n int64, counter *atomic.Uint64) {
		counter.Add(uint64(n))
		ch <- n
	}
	go func() {
		n, _ := io.Copy(dst, src)
		// The counter is published as soon as one direction is done, so the
		// statistics stay meaningful while the other half is still open.
		publish(upCh, n, &p.upBytes)
		closeWrite(dst)
	}()
	go func() {
		n, _ := io.Copy(src, dst)
		publish(downCh, n, &p.downBytes)
		closeWrite(src)
	}()

	up, down := <-upCh, <-downCh
	timer.Stop()
	shutdown()
	return up, down
}

func closeWrite(c net.Conn) {
	if hc, ok := c.(halfCloser); ok {
		_ = hc.CloseWrite()
		return
	}
	_ = c.Close()
}

// allow applies the source address access rule of the listener and logs a
// refusal.
func (p *proxy) allow(remote net.Addr) bool { return p.f.allow(p.rule, remote) }

func (p *proxy) record(e accessEntry) { p.f.access.append(e) }

// ---------------------------------------------------------------------------
// UDP
// ---------------------------------------------------------------------------

type udpSession struct {
	conn      net.Conn
	client    net.Addr
	created   time.Time
	lastSeen  time.Time
	packets   uint64
	upBytes   uint64
	downBytes uint64
	mu        sync.Mutex
}

func (s *udpSession) touch() {
	s.mu.Lock()
	s.lastSeen = time.Now()
	s.mu.Unlock()
}

func (s *udpSession) lastSeenTime() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastSeen
}

func (s *udpSession) counters() (uint64, uint64, uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.packets, s.upBytes, s.downBytes
}

func (s *udpSession) close() { _ = s.conn.Close() }

func (p *proxy) udpReadLoop(pc net.PacketConn) {
	defer p.wg.Done()
	buf := make([]byte, udpBufferSize)
	for {
		n, client, err := pc.ReadFrom(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				if !p.isRunning() {
					return
				}
				continue
			}
			p.f.log.Warn("forward: udp read failed", "rule", ruleLabel(p.rule), "error", err)
			if !p.isRunning() {
				return
			}
			continue
		}
		payload := make([]byte, n)
		copy(payload, buf[:n])
		p.wg.Add(1)
		go p.handleUDP(pc, client, payload)
	}
}

// handleUDP forwards one datagram. A session (map entry plus a connected
// target socket) is created on the first packet of a client address and reused
// until it goes idle; the number of concurrent sessions is capped by the
// connection limits of the rule so it cannot be abused as a reflection
// amplifier.
func (p *proxy) handleUDP(pc net.PacketConn, client net.Addr, data []byte) {
	defer p.wg.Done()
	if !p.isRunning() {
		return
	}
	key := client.String()

	ip := clientIPKey(client)
	p.mu.Lock()
	sess := p.sessions[key]
	if sess == nil {
		limit := sessionLimit(p.rule)
		if limit > 0 && len(p.sessions) >= limit {
			p.mu.Unlock()
			p.rejectDatagram(key, reasonRuleLimit, limit)
			return
		}
		if perIP := maxConnsPerIP(p.rule); perIP > 0 && ip != "" && p.sessPerIP[ip] >= perIP {
			p.mu.Unlock()
			p.rejectDatagram(key, reasonIPLimit, perIP)
			return
		}
		sess = &udpSession{created: time.Now(), lastSeen: time.Now(), client: client}
		p.sessions[key] = sess
		if ip != "" {
			p.sessPerIP[ip]++
		}
		p.mu.Unlock()

		if !p.allow(client) {
			p.removeSession(key, sess, "denied")
			p.f.log.Warn("forward: udp packet denied by the access rule",
				"rule", ruleLabel(p.rule), "client", key)
			return
		}

		dialer := net.Dialer{Timeout: dialTimeout}
		conn, err := dialer.Dial(protoUDP, p.rule.DstAddr)
		if err != nil {
			p.removeSession(key, sess, "failed: "+err.Error())
			p.f.log.Warn("forward: cannot reach the udp destination",
				"rule", ruleLabel(p.rule), "dst", p.rule.DstAddr, "error", err)
			return
		}
		sess.conn = conn
		p.pending.Add(1)
		p.total.Add(1)
		p.active.Add(1)
		go p.udpReplyLoop(pc, key, sess)
	}

	if _, err := sess.conn.Write(data); err != nil {
		p.removeSession(key, sess, "failed: "+err.Error())
		return
	}
	sess.mu.Lock()
	sess.packets++
	sess.upBytes += uint64(len(data))
	sess.mu.Unlock()
	sess.touch()
}

// udpReplyLoop relays the answers of the target back to the client until the
// session goes idle.
func (p *proxy) udpReplyLoop(pc net.PacketConn, key string, sess *udpSession) {
	defer p.pending.Done()
	defer func() {
		p.active.Add(-1)
		p.removeSession(key, sess, "closed")
	}()

	buf := make([]byte, udpBufferSize)
	for {
		if !p.isRunning() {
			return
		}
		// The read wakes up regularly so a stopped proxy does not have to wait
		// for the full session timeout before its goroutine can exit.
		_ = sess.conn.SetReadDeadline(time.Now().Add(udpPollInterval))
		n, err := sess.conn.Read(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				if time.Since(sess.lastSeenTime()) >= udpSessionTTL {
					return
				}
				continue
			}
			return
		}
		if _, werr := pc.WriteTo(buf[:n], sess.client); werr != nil {
			return
		}
		sess.mu.Lock()
		sess.downBytes += uint64(n)
		sess.mu.Unlock()
		sess.touch()
	}
}

// removeSession closes a session exactly once and records its traffic.
func (p *proxy) removeSession(key string, sess *udpSession, result string) {
	p.mu.Lock()
	current, ok := p.sessions[key]
	if ok && current == sess {
		delete(p.sessions, key)
		if ip := clientIPKey(sess.client); ip != "" {
			switch n := p.sessPerIP[ip]; {
			case n <= 1:
				delete(p.sessPerIP, ip)
			default:
				p.sessPerIP[ip] = n - 1
			}
		}
	}
	p.mu.Unlock()
	if !ok || current != sess {
		return
	}
	sess.close()
	packets, up, down := sess.counters()
	p.upBytes.Add(up)
	p.downBytes.Add(down)
	p.record(accessEntry{
		Time:     time.Now(),
		RuleID:   p.rule.ID,
		Rule:     ruleLabel(p.rule),
		Protocol: protoUDP,
		Client:   key,
		Target:   p.rule.DstAddr,
		Result:   result,
		Duration: time.Since(sess.created),
		BytesIn:  int64(up),
		BytesOut: int64(down),
		Packets:  packets,
	})
}

// rejectDatagram records and counts a datagram dropped by a concurrency
// limit.
func (p *proxy) rejectDatagram(client string, reason string, limit int) {
	p.countRejection(reason)
	p.record(accessEntry{
		Time:     time.Now(),
		RuleID:   p.rule.ID,
		Rule:     ruleLabel(p.rule),
		Protocol: protoUDP,
		Client:   client,
		Target:   p.rule.DstAddr,
		Result:   "dropped: " + reason,
	})
	p.f.log.Warn("forward: udp datagram dropped by a concurrency limit",
		"rule", ruleLabel(p.rule), "client", client, "reason", reason, "limit", limit)
}

// udpSweepLoop reclaims the sessions that have been idle for too long. The
// tick interval is short so that the loop also notices a stopped proxy without
// having to wait for the session timeout.
func (p *proxy) udpSweepLoop() {
	defer p.wg.Done()
	ticker := time.NewTicker(udpPollInterval)
	defer ticker.Stop()
	for range ticker.C {
		if !p.isRunning() {
			return
		}
		now := time.Now()
		type staleSession struct {
			key  string
			sess *udpSession
		}
		var stale []staleSession
		p.mu.Lock()
		for key, sess := range p.sessions {
			if now.Sub(sess.lastSeenTime()) >= udpSessionTTL {
				stale = append(stale, staleSession{key: key, sess: sess})
			}
		}
		p.mu.Unlock()
		for _, item := range stale {
			p.removeSession(item.key, item.sess, "idle timeout")
		}
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// listenAddr normalises a rule source address for the net package, so that
// IPv6 wildcards such as "[::]:80" and bare ports both work.
func listenAddr(addr string) string {
	normalized, err := netutil.NormalizeListen(addr)
	if err != nil {
		return addr
	}
	return normalized
}

func addrString(a net.Addr) string {
	if a == nil {
		return ""
	}
	return a.String()
}

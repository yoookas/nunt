package dnsprov

// registerBuiltins installs every compiled in provider.
//
// Each provider lives in its own file and exports a register function with the
// signature func(*Registry). Add the call here when you add a provider file so
// the registry stays in sync with the build.
func registerBuiltins(r *Registry) {
	registerCloudflare(r)
	registerAliDNS(r)
	registerDNSPod(r)
	registerDynv6(r)
	registerDuckDNS(r)
	registerNoIP(r)
	registerFreeDNS(r)
	registerDESEC(r)
	registerPorkbun(r)
	registerNameSilo(r)
	registerGoDaddy(r)
	registerNamecheap(r)
	registerVercel(r)
	registerCustom(r)
}

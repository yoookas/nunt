// Package backup writes archives of the data directory.
//
// The archive holds the files that cannot be recreated: the configuration, the
// key that decrypts the stored credentials, the certificates and the ACME
// account. Logs and earlier backups are deliberately left out, so an archive
// stays small enough to keep several of them around.
package backup

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// NamePrefix marks the archives this package creates.
const NamePrefix = "nunt-backup-"

// Defaults and bounds of the retention policy.
const (
	DefaultKeep     = 7
	MaxKeep         = 60
	DefaultInterval = 24 // hours
	MaxInterval     = 24 * 30
)

// Info describes one stored archive.
type Info struct {
	Name    string    `json:"name"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
}

// includes lists the entries that go into an archive, relative to the data
// directory. Anything else (logs, backups, temporary files) is skipped.
var includes = []string{
	"config.json",
	"config.json.bak",
	"secret.key",
	"certs",
	"acme",
}

// Dir returns the directory archives are written to: the configured one, or
// <dataDir>/backups by default.
func Dir(dataDir, configured string) string {
	if strings.TrimSpace(configured) != "" {
		return configured
	}
	return filepath.Join(dataDir, "backups")
}

// Create writes a compressed archive of dataDir into destDir and prunes old
// archives. It returns the path of the new archive.
func Create(dataDir, destDir string, keep int, now time.Time) (string, error) {
	if strings.TrimSpace(dataDir) == "" {
		return "", errors.New("backup: data directory is required")
	}
	destDir = Dir(dataDir, destDir)
	if keep <= 0 {
		keep = DefaultKeep
	}
	if keep > MaxKeep {
		keep = MaxKeep
	}
	if err := os.MkdirAll(destDir, 0o750); err != nil {
		return "", fmt.Errorf("create backup directory: %w", err)
	}

	name := NamePrefix + now.Format("20060102-150405") + ".tar.gz"
	final := filepath.Join(destDir, name)
	tmp, err := os.CreateTemp(destDir, ".backup-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create backup file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()

	if err := writeArchive(tmp, dataDir); err != nil {
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		return "", fmt.Errorf("sync backup: %w", err)
	}
	// The archive contains secret.key: it must not be readable by others.
	if err := tmp.Chmod(0o600); err != nil {
		return "", fmt.Errorf("chmod backup: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("close backup: %w", err)
	}
	if err := os.Rename(tmpName, final); err != nil {
		return "", fmt.Errorf("publish backup: %w", err)
	}
	if err := prune(destDir, keep); err != nil {
		return final, err
	}
	return final, nil
}

func writeArchive(out io.Writer, dataDir string) error {
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)

	for _, entry := range includes {
		root := filepath.Join(dataDir, entry)
		info, err := os.Lstat(root)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				// A fresh installation has no acme/ yet: skip, do not fail.
				continue
			}
			return fmt.Errorf("backup: stat %s: %w", entry, err)
		}
		if !info.IsDir() {
			if err := addFile(tw, dataDir, entry, info); err != nil {
				return err
			}
			continue
		}
		err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if d.IsDir() {
				return nil
			}
			rel, err := filepath.Rel(dataDir, path)
			if err != nil {
				return err
			}
			fi, err := d.Info()
			if err != nil {
				return err
			}
			return addFile(tw, dataDir, rel, fi)
		})
		if err != nil {
			return fmt.Errorf("backup: walk %s: %w", entry, err)
		}
	}

	if err := tw.Close(); err != nil {
		return fmt.Errorf("finish archive: %w", err)
	}
	if err := gz.Close(); err != nil {
		return fmt.Errorf("finish compression: %w", err)
	}
	return nil
}

func addFile(tw *tar.Writer, dataDir, rel string, info fs.FileInfo) error {
	path := filepath.Join(dataDir, rel)
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("backup: open %s: %w", rel, err)
	}
	defer f.Close()

	header := &tar.Header{
		Name:     filepath.ToSlash(rel),
		Mode:     0o600,
		Size:     info.Size(),
		ModTime:  info.ModTime(),
		Typeflag: tar.TypeReg,
	}
	if err := tw.WriteHeader(header); err != nil {
		return fmt.Errorf("backup: header %s: %w", rel, err)
	}
	if _, err := io.Copy(tw, f); err != nil {
		return fmt.Errorf("backup: copy %s: %w", rel, err)
	}
	return nil
}

// List returns the stored archives, newest first.
func List(destDir string) ([]Info, error) {
	entries, err := os.ReadDir(destDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []Info{}, nil
		}
		return nil, fmt.Errorf("read backup directory: %w", err)
	}
	out := make([]Info, 0, len(entries))
	for _, de := range entries {
		if de.IsDir() || !strings.HasPrefix(de.Name(), NamePrefix) || !strings.HasSuffix(de.Name(), ".tar.gz") {
			continue
		}
		fi, err := de.Info()
		if err != nil {
			continue
		}
		out = append(out, Info{Name: de.Name(), Size: fi.Size(), ModTime: fi.ModTime()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name > out[j].Name })
	return out, nil
}

// Newest returns the modification time of the most recent archive, or the zero
// time when there is none.
func Newest(destDir string) time.Time {
	infos, err := List(destDir)
	if err != nil || len(infos) == 0 {
		return time.Time{}
	}
	return infos[0].ModTime
}

// prune removes all but the newest keep archives.
func prune(destDir string, keep int) error {
	infos, err := List(destDir)
	if err != nil {
		return err
	}
	for i := keep; i < len(infos); i++ {
		path := filepath.Join(destDir, infos[i].Name)
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("prune %s: %w", infos[i].Name, err)
		}
	}
	return nil
}

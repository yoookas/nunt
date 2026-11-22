package vfs

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func newLocal(t *testing.T) *Local {
	t.Helper()
	fs, err := OpenLocal(t.TempDir(), "test", false)
	if err != nil {
		t.Fatalf("open local: %v", err)
	}
	t.Cleanup(func() { _ = fs.Close() })
	return fs
}

func TestLocalCrud(t *testing.T) {
	ctx := context.Background()
	fs := newLocal(t)

	if _, err := fs.Create(ctx, "/docs/readme.txt", strings.NewReader("hello world")); err != nil {
		t.Fatalf("create: %v", err)
	}
	entry, err := fs.Stat(ctx, "/docs/readme.txt")
	if err != nil || entry.Dir || entry.Size != 11 {
		t.Fatalf("stat = %+v, %v", entry, err)
	}

	rc, _, err := fs.Open(ctx, "/docs/readme.txt", 6, 5)
	if err != nil {
		t.Fatalf("open range: %v", err)
	}
	data, _ := io.ReadAll(rc)
	_ = rc.Close()
	if string(data) != "world" {
		t.Fatalf("range read = %q", data)
	}

	entries, err := fs.List(ctx, "/docs", false)
	if err != nil || len(entries) != 1 || entries[0].Name != "readme.txt" {
		t.Fatalf("list = %+v, %v", entries, err)
	}

	if err := fs.Rename(ctx, "/docs/readme.txt", "/docs/notes.txt"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if _, err := fs.Stat(ctx, "/docs/notes.txt"); err != nil {
		t.Fatalf("renamed file must exist: %v", err)
	}
	if err := fs.Remove(ctx, "/docs", false); !errors.Is(err, ErrNotEmpty) {
		t.Fatalf("removing a non empty directory must fail, got %v", err)
	}
	if err := fs.Remove(ctx, "/docs", true); err != nil {
		t.Fatalf("recursive remove: %v", err)
	}
	if _, err := fs.Stat(ctx, "/docs"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("the directory must be gone, got %v", err)
	}
}

func TestCleanRejectsTraversal(t *testing.T) {
	cases := map[string]string{
		"../../etc/passwd": "/etc/passwd",
		"/a/b/../c":        "/a/c",
		"":                 "/",
		"a//b/":            "/a/b",
	}
	for in, want := range cases {
		got, err := Clean(in)
		if err != nil {
			t.Fatalf("Clean(%q) returned %v", in, err)
		}
		if got != want {
			t.Fatalf("Clean(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := Clean("/a/\x00b"); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("a NUL byte must be rejected")
	}
}

func TestLocalStaysInsideRoot(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	outside := filepath.Join(filepath.Dir(root), "outside.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	fs, err := OpenLocal(root, "test", false)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = fs.Close() }()

	if _, _, err := fs.Open(ctx, "/../outside.txt", 0, 0); !errors.Is(err, ErrNotExist) {
		t.Fatalf("traversal must not escape the root, got %v", err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink(outside, filepath.Join(root, "link.txt")); err == nil {
			if _, _, err := fs.Open(ctx, "/link.txt", 0, 0); err == nil {
				t.Fatal("a symlink pointing outside the root must be refused")
			}
		}
	}
}

func TestReadOnlyBackend(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o600); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	fs, err := OpenLocal(root, "ro", true)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = fs.Close() }()
	if !fs.ReadOnly() {
		t.Fatal("ReadOnly must report true")
	}
	if _, err := fs.Create(ctx, "/b.txt", strings.NewReader("nope")); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("writes must be refused, got %v", err)
	}
	if err := fs.Remove(ctx, "/a.txt", false); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("removals must be refused, got %v", err)
	}
	if _, _, err := fs.Open(ctx, "/a.txt", 0, 0); err != nil {
		t.Fatalf("reads must still work: %v", err)
	}
}

// Mkdir creates the whole chain, as the FS contract says ("parents included").
func TestMkdirCreatesParents(t *testing.T) {
	ctx := context.Background()
	fs := newLocal(t)

	if err := fs.Mkdir(ctx, "/a/b/c"); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	entry, err := fs.Stat(ctx, "/a/b/c")
	if err != nil || !entry.Dir {
		t.Fatalf("the directory was not created: %+v %v", entry, err)
	}
	// Creating it again stays a no-op.
	if err := fs.Mkdir(ctx, "/a/b/c"); err != nil {
		t.Fatalf("mkdir again: %v", err)
	}
}

// A file occupying the path is not a directory, and Mkdir must say so.
func TestMkdirOverAFileFails(t *testing.T) {
	ctx := context.Background()
	fs := newLocal(t)
	if _, err := fs.Create(ctx, "/file.txt", strings.NewReader("x")); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := fs.Mkdir(ctx, "/file.txt"); err == nil {
		t.Fatal("Mkdir over a file must fail")
	}
}

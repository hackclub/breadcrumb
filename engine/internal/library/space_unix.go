//go:build !windows

package library

import "syscall"

func Available(path string) (uint64, error) {
	var stat syscall.Statfs_t
	err := syscall.Statfs(path, &stat)
	return uint64(stat.Bavail) * uint64(stat.Bsize), err
}

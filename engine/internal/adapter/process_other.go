//go:build !windows

package adapter

import "os/exec"

func configureCommand(_ *exec.Cmd) {}

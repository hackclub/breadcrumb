//go:build !windows

package agentusage

import (
	"fmt"
	"os"
	"syscall"
)

func identity(f *os.File) string {
	i, e := f.Stat()
	if e != nil {
		return ""
	}
	if st, ok := i.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d:%d", st.Dev, st.Ino)
	}
	return ""
}

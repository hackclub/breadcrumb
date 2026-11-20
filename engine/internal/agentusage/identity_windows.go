package agentusage

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
)

func identity(f *os.File) string {
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &info) != nil {
		return ""
	}
	return fmt.Sprintf("%d:%d:%d", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow)
}

package adapter

import (
	"bufio"
	"encoding/json"
	"errors"
	"github.com/hackclub/breadcrumb/engine/internal/library"
	"io"
	"os/exec"
	"sync"
	"time"
)

type Capabilities struct {
	Screenshot    bool   `json:"screenshot"`
	Accessibility bool   `json:"accessibility"`
	OCR           bool   `json:"ocr"`
	WindowContext bool   `json:"windowContext"`
	Exclusions    string `json:"exclusions"`
	Backend       string `json:"backend"`
	Permission    string `json:"permission"`
	Idle          bool   `json:"idle"`
}
type Response struct {
	Icon                string `json:"icon,omitempty"`
	RecordingPreference *bool  `json:"recordingPreference"`
	OK                  bool   `json:"ok"`
	Error               string `json:"error"`
	ContextKey          string `json:"contextKey"`
	// IdleSeconds is the time since the last user input; nil when the platform cannot report it.
	IdleSeconds  *float64        `json:"idleSeconds"`
	Record       library.Record  `json:"record"`
	Payload      library.Payload `json:"payload"`
	Capabilities Capabilities    `json:"capabilities"`
}
type Adapter interface {
	Request(command string, settings library.Settings, exclusions []string) (Response, error)
	Close() error
}
type Process struct {
	path string
	mu   sync.Mutex
	cmd  *exec.Cmd
	in   io.WriteCloser
	out  *bufio.Reader
}

func Start(path string) (*Process, error) {
	cmd := exec.Command(path)
	configureCommand(cmd)
	in, e := cmd.StdinPipe()
	if e != nil {
		return nil, e
	}
	out, e := cmd.StdoutPipe()
	if e != nil {
		return nil, e
	}
	if e = cmd.Start(); e != nil {
		return nil, e
	}
	return &Process{path: path, cmd: cmd, in: in, out: bufio.NewReaderSize(out, 16<<20)}, nil
}
func (p *Process) Request(command string, settings library.Settings, exclusions []string) (Response, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd == nil {
		next, err := Start(p.path)
		if err != nil {
			return Response{}, err
		}
		p.cmd = next.cmd
		p.in = next.in
		p.out = next.out
	}
	var response Response
	if e := json.NewEncoder(p.in).Encode(map[string]any{"command": command, "settings": settings, "exclusions": exclusions}); e != nil {
		return response, e
	}
	type output struct {
		line []byte
		err  error
	}
	completed := make(chan output, 1)
	reader := p.out
	go func() { line, err := reader.ReadBytes('\n'); completed <- output{line, err} }()
	timeout := 10 * time.Second
	if command != "probe" {
		timeout = 45 * time.Second
	}
	var line []byte
	select {
	case out := <-completed:
		if out.err != nil {
			p.reset()
			return response, out.err
		}
		line = out.line
	case <-time.After(timeout):
		p.reset()
		return response, errors.New("native capture adapter timed out; retrying next interval")
	}
	if e := json.Unmarshal(line, &response); e != nil {
		return response, e
	}
	if !response.OK {
		return response, errors.New(response.Error)
	}
	return response, nil
}
func (p *Process) reset() {
	if p.cmd != nil {
		p.in.Close()
		p.cmd.Process.Kill()
		p.cmd.Wait()
		p.cmd = nil
	}
}
func (p *Process) Close() error { p.mu.Lock(); defer p.mu.Unlock(); p.reset(); return nil }

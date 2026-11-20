package agentusage

import (
	"io"
	"os"
	"path/filepath"
	"strings"
)

// A directory registers a usage-only plugin without executing code or opening
// its records. Each plugin gets its own opt-in; the generic importer cannot
// bypass a disabled plugin by recursively walking its directory.
type importPlugin struct{ id, root string }

func (p importPlugin) ID() string { return "plugin:" + p.id }
func (p importPlugin) Name() string {
	if p.id == "opencode" {
		return "OpenCode (plugin)"
	}
	return p.id + " (plugin)"
}
func (p importPlugin) Root(_ string) string { return p.root }
func (p importPlugin) Parse(r io.Reader, c *Context) (*Event, error) {
	e, err := (builtin{id: "import"}).Parse(r, c)
	if err == nil && e != nil && e.Provider != p.id {
		return nil, errJSON
	}
	return e, err
}
func (s *Store) providers() []Provider {
	providers := Providers()
	root := filepath.Join(s.dir, "agent-imports")
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if e.IsDir() && e.Type()&os.ModeSymlink == 0 && ident.MatchString(e.Name()) && !strings.ContainsAny(e.Name(), ":@+") && e.Name() != "claude" && e.Name() != "codex" {
			providers = append(providers, importPlugin{e.Name(), filepath.Join(root, e.Name())})
		}
	}
	return providers
}

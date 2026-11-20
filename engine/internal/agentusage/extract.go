package agentusage

// This extractor deliberately does not use json.Decoder.Token: Token allocates
// strings even for ignored content. Only exact allowlisted leaf values are decoded.
import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

type fields map[string]string

var errJSON = errors.New("invalid usage record")

type extractor struct {
	r      *bufio.Reader
	paths  map[string]bool
	out    fields
	strict bool
}

func extract(r io.Reader, paths map[string]bool, strict ...bool) (fields, error) {
	x := extractor{r: bufio.NewReaderSize(r, 4096), paths: paths, out: fields{}, strict: len(strict) > 0 && strict[0]}
	if err := x.value("", 0); err != nil {
		return nil, err
	}
	if _, err := x.next(); err != io.EOF {
		return nil, errJSON
	}
	return x.out, nil
}
func (x *extractor) next() (byte, error) {
	for {
		b, e := x.r.ReadByte()
		if e != nil {
			return b, e
		}
		if b != ' ' && b != '\t' && b != '\r' && b != '\n' {
			return b, nil
		}
	}
}
func (x *extractor) str(keep bool) (string, error) {
	var b []byte
	if keep {
		b = append(b, '"')
	}
	escaped := false
	for {
		c, e := x.r.ReadByte()
		if e != nil {
			return "", e
		}
		if c < 32 {
			return "", errJSON
		}
		if keep {
			if len(b) > 4096 {
				return "", errJSON
			}
			b = append(b, c)
		}
		if c == '"' && !escaped {
			break
		}
		if c == '\\' && !escaped {
			escaped = true
		} else {
			escaped = false
		}
	}
	if !keep {
		return "", nil
	}
	var s string
	if json.Unmarshal(b, &s) != nil {
		return "", errJSON
	}
	return s, nil
}
func (x *extractor) value(path string, depth int) error {
	if depth > 64 {
		return errJSON
	}
	c, e := x.next()
	if e != nil {
		return e
	}
	keep := x.paths[path]
	if x.strict && depth > 0 && !keep {
		return errJSON
	}
	if keep {
		if _, exists := x.out[path]; exists {
			return errJSON
		}
	}
	switch c {
	case '"':
		if x.strict && (path == "input" || path == "cacheRead" || path == "cacheWrite" || path == "cacheWrite1h" || path == "output" || path == "reasoning") {
			return errJSON
		}
		s, e := x.str(keep)
		if e == nil && keep {
			x.out[path] = s
		}
		return e
	case '{':
		if x.strict && depth > 0 {
			return errJSON
		}
		c, e = x.next()
		if e != nil {
			return e
		}
		if c == '}' {
			return nil
		}
		x.r.UnreadByte()
		for {
			c, e = x.next()
			if e != nil || c != '"' {
				return errJSON
			}
			// Keys of discarded objects are discarded too; they cannot contain usage.
			wanted := false
			prefix := path + "."
			if path == "" {
				prefix = ""
			}
			for p := range x.paths {
				if strings.HasPrefix(p, prefix) {
					wanted = true
					break
				}
			}
			key, e := x.str(wanted)
			if e != nil {
				return e
			}
			c, e = x.next()
			if e != nil || c != ':' {
				return errJSON
			}
			child := "!"
			if wanted {
				child = prefix + key
			}
			if e = x.value(child, depth+1); e != nil {
				return e
			}
			c, e = x.next()
			if e != nil {
				return e
			}
			if c == '}' {
				break
			}
			if c != ',' {
				return errJSON
			}
		}
	case '[':
		if x.strict {
			return errJSON
		}
		c, e = x.next()
		if e != nil {
			return e
		}
		if c == ']' {
			return nil
		}
		x.r.UnreadByte()
		for {
			if e = x.value("!", depth+1); e != nil {
				return e
			}
			c, e = x.next()
			if e != nil {
				return e
			}
			if c == ']' {
				break
			}
			if c != ',' {
				return errJSON
			}
		}
	default:
		var b []byte
		b = append(b, c)
		for {
			c, e = x.r.ReadByte()
			if e == io.EOF {
				break
			}
			if e != nil {
				return e
			}
			if c == ',' || c == '}' || c == ']' || c == ' ' || c == '\r' || c == '\n' || c == '\t' {
				x.r.UnreadByte()
				break
			}
			if len(b) > 64 {
				return errJSON
			}
			b = append(b, c)
		}
		if !json.Valid(b) {
			return errJSON
		}
		if keep {
			if x.strict && path != "input" && path != "cacheRead" && path != "cacheWrite" && path != "cacheWrite1h" && path != "output" && path != "reasoning" {
				return errJSON
			}
			x.out[path] = string(b)
		}
	}
	return nil
}

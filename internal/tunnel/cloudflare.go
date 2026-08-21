package tunnel

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var tryURL = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)

// Cloudflare runs `cloudflared tunnel --url http://HOST:PORT` and returns the
// public trycloudflare URL. Caller must Cancel the returned context / Kill.
type Cloudflare struct {
	cmd    *exec.Cmd
	cancel context.CancelFunc
	URL    string
}

func StartCloudflare(localURL string) (*Cloudflare, error) {
	if _, err := exec.LookPath("cloudflared"); err != nil {
		return nil, fmt.Errorf("cloudflared not found — brew install cloudflare/cloudflare/cloudflared")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "cloudflared", "tunnel", "--url", localURL, "--no-autoupdate")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}

	urlCh := make(chan string, 1)
	errCh := make(chan error, 1)
	go scanURL(io.MultiReader(stdout, stderr), urlCh, errCh)

	select {
	case url := <-urlCh:
		return &Cloudflare{cmd: cmd, cancel: cancel, URL: url}, nil
	case err := <-errCh:
		cancel()
		_ = cmd.Wait()
		return nil, err
	case <-time.After(25 * time.Second):
		cancel()
		_ = cmd.Wait()
		return nil, fmt.Errorf("timed out waiting for trycloudflare URL")
	}
}

func (c *Cloudflare) Stop() {
	if c == nil {
		return
	}
	if c.cancel != nil {
		c.cancel()
	}
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
		_, _ = c.cmd.Process.Wait()
	}
}

func scanURL(r io.Reader, urlCh chan<- string, errCh chan<- error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if m := tryURL.FindString(line); m != "" {
			urlCh <- strings.TrimSpace(m)
			// keep draining so process doesn't block on full pipe
			go io.Copy(io.Discard, r)
			return
		}
	}
	if err := sc.Err(); err != nil {
		errCh <- err
		return
	}
	errCh <- fmt.Errorf("cloudflared exited before printing a trycloudflare URL")
}

package main

import (
	"bytes"
	"context"
	"errors"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var errMissing = errors.New("object not found")

type objectStore interface {
	List(context.Context, string, string, int) ([]string, string, error)
	Get(context.Context, string) ([]byte, error)
	Create(context.Context, string, []byte) (bool, error)
	Delete(context.Context, string) error
}
type r2Store struct {
	client *s3.Client
	bucket string
}

func newR2Store(endpoint, bucket, key, secret string) *r2Store {
	client := s3.New(s3.Options{Region: "auto", BaseEndpoint: aws.String(endpoint), Credentials: credentials.NewStaticCredentialsProvider(key, secret, ""), UsePathStyle: true, RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired, ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired})
	return &r2Store{client, bucket}
}
func (s *r2Store) Get(ctx context.Context, key string) ([]byte, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		var api smithy.APIError
		if errors.As(err, &api) && api.ErrorCode() == "NoSuchKey" {
			return nil, errMissing
		}
		return nil, err
	}
	defer out.Body.Close()
	return io.ReadAll(io.LimitReader(out.Body, maxUpload+1<<20))
}
func (s *r2Store) Create(ctx context.Context, key string, data []byte) (bool, error) {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &s.bucket, Key: &key, Body: bytes.NewReader(data), ContentType: aws.String("application/json"), IfNoneMatch: aws.String("*")})
	if err != nil {
		var api smithy.APIError
		if errors.As(err, &api) && (api.ErrorCode() == "PreconditionFailed" || api.ErrorCode() == "ConditionalRequestConflict") {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
func (s *r2Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.bucket, Key: &key})
	return err
}

// Local development only. Link publishes a complete file without replacing an existing object.
type localStore struct{ dir string }

func (s *localStore) Get(_ context.Context, key string) ([]byte, error) {
	b, e := os.ReadFile(filepath.Join(s.dir, key))
	if os.IsNotExist(e) {
		e = errMissing
	}
	return b, e
}
func (s *localStore) Create(_ context.Context, key string, data []byte) (bool, error) {
	path := filepath.Join(s.dir, key)
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return false, e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".pending-")
	if e != nil {
		return false, e
	}
	defer os.Remove(f.Name())
	_, e = f.Write(data)
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return false, e
	}
	e = os.Link(f.Name(), path)
	if os.IsExist(e) {
		return false, nil
	}
	return e == nil, e
}
func (s *localStore) Delete(_ context.Context, key string) error {
	e := os.Remove(filepath.Join(s.dir, key))
	if os.IsNotExist(e) {
		return nil
	}
	return e
}

// List returns a lexicographic page and an opaque continuation cursor.
func (s *r2Store) List(ctx context.Context, prefix, cursor string, limit int) ([]string, string, error) {
	in := &s3.ListObjectsV2Input{Bucket: &s.bucket, Prefix: &prefix, MaxKeys: aws.Int32(int32(limit))}
	if cursor != "" {
		in.ContinuationToken = &cursor
	}
	out, e := s.client.ListObjectsV2(ctx, in)
	if e != nil {
		return nil, "", e
	}
	keys := []string{}
	for _, object := range out.Contents {
		keys = append(keys, aws.ToString(object.Key))
	}
	return keys, aws.ToString(out.NextContinuationToken), nil
}
func (s *localStore) List(_ context.Context, prefix, cursor string, limit int) ([]string, string, error) {
	keys := []string{}
	e := filepath.WalkDir(s.dir, func(path string, entry os.DirEntry, e error) error {
		if os.IsNotExist(e) {
			return nil
		}
		if e != nil {
			return e
		}
		if entry.IsDir() {
			return nil
		}
		rel, e := filepath.Rel(s.dir, path)
		if e != nil {
			return e
		}
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, prefix) && rel > cursor && !strings.HasPrefix(entry.Name(), ".pending-") {
			keys = append(keys, rel)
		}
		return nil
	})
	if e != nil {
		return nil, "", e
	}
	sort.Strings(keys)
	if len(keys) > limit {
		return keys[:limit], keys[limit-1], nil
	}
	return keys, "", nil
}

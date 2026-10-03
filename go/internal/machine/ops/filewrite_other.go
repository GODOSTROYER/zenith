//go:build !linux

package ops

import "context"

func fileWritePlatform() bool { return false }
func runFileWrite(context.Context, *Env, fileWriteArgs, FileWriteProfile) (Result, error) {
	return Result{}, unsupportedf("file.write requires Linux")
}

package api

import "errors"

var (
	errAlreadyExists = errors.New("already exists")
	errNotFound      = errors.New("not found")
	errLastUser      = errors.New("the last administrator account cannot be deleted")
)

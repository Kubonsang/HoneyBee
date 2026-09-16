//go:build windows && !honeybee_qualification

package main

// Production builds expose neither fault commands nor file/environment switches.
func qualificationCommand([]string) (any, bool, error)                 { return nil, false, nil }
func qualificationMigrationCheckpoint(*serviceMigration, string) error { return nil }

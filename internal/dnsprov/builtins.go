package dnsprov

// registerBuiltins installs every compiled in provider.
//
// Each provider lives in its own file and exports a register function with the
// signature func(*Registry). Add the call here when you add a provider file so
// the registry stays in sync with the build.
func registerBuiltins(r *Registry) {
	registerAliDNS(r)
	registerDNSPod(r)
	registerCustom(r)
}

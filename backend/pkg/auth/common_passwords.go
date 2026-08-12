package auth

import "strings"

// commonPasswords is an embedded list of the most widely-breached passwords (#506).
//
// WHY EMBEDDED AND WHY SHORT. The stronger option is the Pwned Passwords k-anonymity API, which
// checks against ~850 million breached hashes — and adds an outbound network call to sign-up. That
// is unacceptable for a self-hosted personal health record that has to work on a LAN with no
// internet, and it tells a third party that somebody just set a password on this instance. A short
// embedded list gets most of the value with none of that: these are the passwords tried FIRST in
// every credential-stuffing run, so rejecting them removes the cheapest attack outright.
//
// Drawn from the perennial top of the SecLists / Have I Been Pwned published rankings. Deliberately
// not thousands of entries: the long tail adds little against an online attacker (who is rate
// limited — see #509) and every entry is one more password a legitimate user is told they cannot
// have.
//
// Comparison is case-insensitive and ignores trailing digits people append to dodge exactly this
// kind of list, so `password1`, `Password`, and `password123` are all caught by `password`.
var commonPasswords = map[string]bool{
	"123456": true, "password": true, "12345678": true, "qwerty": true, "123456789": true,
	"12345": true, "1234": true, "111111": true, "1234567": true, "dragon": true,
	"123123": true, "baseball": true, "abc123": true, "football": true, "monkey": true,
	"letmein": true, "shadow": true, "master": true, "666666": true, "qwertyuiop": true,
	"123321": true, "mustang": true, "1234567890": true, "michael": true, "654321": true,
	"superman": true, "1qaz2wsx": true, "7777777": true, "121212": true, "000000": true,
	"qazwsx": true, "123qwe": true, "killer": true, "trustno1": true, "jordan": true,
	"jennifer": true, "zxcvbnm": true, "asdfgh": true, "hunter": true, "buster": true,
	"soccer": true, "harley": true, "batman": true, "andrew": true, "tigger": true,
	"sunshine": true, "iloveyou": true, "charlie": true, "robert": true, "thomas": true,
	"hockey": true, "ranger": true, "daniel": true, "starwars": true, "klaster": true,
	"112233": true, "george": true, "computer": true, "michelle": true, "jessica": true,
	"pepper": true, "zxcvbn": true, "555555": true, "11111111": true, "131313": true,
	"freedom": true, "777777": true, "pass": true, "maggie": true, "159753": true,
	"aaaaaa": true, "ginger": true, "princess": true, "joshua": true, "cheese": true,
	"amanda": true, "summer": true, "love": true, "ashley": true, "nicole": true,
	"chelsea": true, "biteme": true, "matthew": true, "access": true, "yankees": true,
	"987654321": true, "dallas": true, "austin": true, "thunder": true, "taylor": true,
	"matrix": true, "mobilemail": true, "mom": true, "monitor": true, "monitoring": true,
	"montana": true, "moon": true, "moscow": true, "admin": true, "administrator": true,
	"welcome": true, "login": true, "passw0rd": true, "starwars1": true, "qwerty123": true,
	"letmein1": true, "secret": true, "changeme": true, "default": true, "temp": true,
	"guest": true, "test": true, "demo": true, "sample": true, "example": true,
	"health": true, "medical": true, "doctor": true, "patient": true, "hospital": true,
}

// isCommonPassword reports whether the password is on the list, ignoring case and any trailing
// digits. `Password1`, `password123` and `PASSWORD` all reduce to `password`.
//
// Both forms are checked — the raw lowercase value as well as the stripped one — so an entry that
// legitimately ends in digits (`123456`, `7777777`) is still matched exactly.
func isCommonPassword(password string) bool {
	lowered := strings.ToLower(strings.TrimSpace(password))
	if commonPasswords[lowered] {
		return true
	}
	return commonPasswords[strings.TrimRight(lowered, "0123456789")]
}

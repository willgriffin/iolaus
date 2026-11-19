import Foundation

let valid = [
    "https://jobgeni.us/auth/magic-link?token=fictional",
    "https://jobgeni.us/auth/magic-link/?token=fictional",
    " https://jobgeni.us:443/auth/magic-link?token=fictional "
]
let invalid = [
    "http://jobgeni.us/auth/magic-link?token=fictional",
    "https://jobgeni.us.evil.test/auth/magic-link?token=fictional",
    "https://evil.test/auth/magic-link?token=fictional",
    "https://user@jobgeni.us/auth/magic-link?token=fictional",
    "https://jobgeni.us:444/auth/magic-link?token=fictional",
    "https://jobgeni.us/auth/magic-link?token=fictional#fragment",
    "https://jobgeni.us/auth/magic-link?token=fictional&next=https://evil.test",
    "https://jobgeni.us/auth/magic-link?token=a&token=b",
    "https://jobgeni.us/auth/magic-link?token=",
    "https://jobgeni.us/auth/magic-link",
    "https://jobgeni.us/auth/magic-link?other=value",
    "https://jobgeni.us/auth/magic-link/other?token=fictional",
    "https://jobgeni.us/auth/magic-link?token=" + String(repeating: "a", count: 4097),
    "not a URL"
]
for link in valid { precondition(SignInLink.destination(link) != nil, "Valid link rejected") }
for link in invalid { precondition(SignInLink.destination(link) == nil, "Invalid link accepted") }
print("Sign-in navigation: 3 valid and 14 invalid cases passed")

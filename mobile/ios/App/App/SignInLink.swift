import Foundation

// Navigation only: verification, consumption and session cookies belong to the hosted route.
enum SignInLink {
    static func destination(_ input: String, origin: URL = URL(string: "https://jobgeni.us")!) -> URL? {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf8.count <= 8192,
              let parts = URLComponents(string: value),
              let expected = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              ["https", "http"].contains(expected.scheme ?? ""),
              parts.scheme == expected.scheme, parts.host == expected.host,
              (parts.port ?? (parts.scheme == "https" ? 443 : 80)) == (expected.port ?? (expected.scheme == "https" ? 443 : 80)),
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              parts.path == "/auth/magic-link" || parts.path == "/auth/magic-link/",
              let items = parts.queryItems, items.count == 1,
              items[0].name == "token", let token = items[0].value,
              !token.isEmpty, token.utf8.count <= 4096,
              let url = parts.url else { return nil }
        return url
    }
}

import Foundation

// Navigation only: verification, consumption and session cookies belong to the hosted route.
enum SignInLink {
    static func destination(_ input: String) -> URL? {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf8.count <= 8192,
              let parts = URLComponents(string: value),
              parts.scheme == "https", parts.host == "jobgeni.us",
              parts.port == nil || parts.port == 443,
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              parts.path == "/auth/magic-link" || parts.path == "/auth/magic-link/",
              let items = parts.queryItems, items.count == 1,
              items[0].name == "token", let token = items[0].value,
              !token.isEmpty, token.utf8.count <= 4096,
              let url = parts.url else { return nil }
        return url
    }
}

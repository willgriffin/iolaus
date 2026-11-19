package us.jobgeni.app;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
/** Navigation only: hosted confirmation owns validation and sessions. */
public final class SignInLink {
    private SignInLink() {}
    public static String destination(String input, String origin) {
        try {
            String value=input.trim();
            if(value.getBytes(StandardCharsets.UTF_8).length>8192) return null;
            URI url=new URI(value), expected=new URI(origin);
            if (!("https".equals(expected.getScheme()) || "http".equals(expected.getScheme())) ||
                !expected.getScheme().equals(url.getScheme()) || expected.getHost()==null ||
                !expected.getHost().equals(url.getHost()) || port(url)!=port(expected) ||
                url.getRawUserInfo()!=null || url.getRawFragment()!=null ||
                !("/auth/magic-link".equals(url.getPath()) || "/auth/magic-link/".equals(url.getPath()))) return null;
            String query=url.getRawQuery();
            if(query==null || query.contains("&")) return null;
            String[] field=query.split("=",2);
            if(field.length!=2 || !"token".equals(decode(field[0]))) return null;
            String token=decode(field[1]);
            if(token.isEmpty() || token.getBytes(StandardCharsets.UTF_8).length>4096) return null;
            return url.toASCIIString();
        } catch(Exception invalid) { return null; }
    }
    private static String decode(String value) throws Exception { return URLDecoder.decode(value,"UTF-8"); }
    private static int port(URI uri) { return uri.getPort()==-1 ? ("https".equals(uri.getScheme())?443:80) : uri.getPort(); }
}

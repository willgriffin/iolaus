package us.jobgeni.app;
import org.junit.Test;
import static org.junit.Assert.*;
public class SignInLinkTest {
    @Test public void exactOriginAndTokenOnly() {
        String origin="https://jobgeni.us";
        assertNotNull(SignInLink.destination("https://jobgeni.us/auth/magic-link?token=fictional",origin));
        assertNotNull(SignInLink.destination("https://jobgeni.us:443/auth/magic-link/?token=fictional",origin));
        for(String value:new String[]{"http://jobgeni.us/auth/magic-link?token=a","https://evil.test/auth/magic-link?token=a","https://jobgeni.us:444/auth/magic-link?token=a","https://user@jobgeni.us/auth/magic-link?token=a","https://jobgeni.us/auth/magic-link?token=a#fragment","https://jobgeni.us/auth/magic-link?token=a&token=b","https://jobgeni.us/auth/magic-link?token=","https://jobgeni.us/auth/magic-link?other=a","https://jobgeni.us/other?token=a","not a URL","https://jobgeni.us/auth/magic-link?token=%ZZ"}) assertNull(SignInLink.destination(value,origin));
        assertNotNull(SignInLink.destination("https://jobgeni.us/auth/magic-link?token="+"a".repeat(4096),origin));
        assertNull(SignInLink.destination("https://jobgeni.us/auth/magic-link?token="+"a".repeat(4097),origin));
        assertNull(SignInLink.destination("https://jobgeni.us/auth/magic-link?token="+"a".repeat(9000),origin));
        assertNotNull(SignInLink.destination("https://localhost:34472/auth/magic-link?token=a","https://localhost:34472"));
        assertNull(SignInLink.destination("https://localhost:34473/auth/magic-link?token=a","https://localhost:34472"));
        assertNull(SignInLink.destination("https://localhost:34472/auth/magic-link?token=a",origin));
    }
}

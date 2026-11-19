package us.jobgeni.app;
import android.content.Context;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import androidx.test.espresso.web.webdriver.Locator;
import org.junit.*;
import org.junit.runner.RunWith;
import java.io.File;
import java.net.*;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;
import static androidx.test.espresso.web.sugar.Web.onWebView;
import static androidx.test.espresso.web.webdriver.DriverAtoms.*;
import static androidx.test.espresso.web.assertion.WebViewAssertions.webMatches;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.is;

/** Real UI and real mail challenge. Requires the isolated HTTPS/SMTP/S3/PostgreSQL fixture. */
@RunWith(AndroidJUnit4.class)
public class HostedPhoneTest {
    private UiDevice device;
    @Before public void setup(){
        device=UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue("Use isolated QA bundle only",context.getPackageName().endsWith(".qa"));
        Intent launch=context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK|Intent.FLAG_ACTIVITY_NEW_TASK);context.startActivity(launch);
    }
    private void shot(String name)throws Exception{
        device.takeScreenshot(new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null),name+".png"));
    }
    private void text(String expected)throws Exception{
        Throwable failure=null;
        for(int i=0;i<40;i++){
            try {onWebView().withElement(findElement(Locator.TAG_NAME,"body")).check(webMatches(getText(),containsString(expected)));return;}
            catch(Throwable pending){failure=pending;Thread.sleep(500);}
        }
        throw new AssertionError("Expected real hosted UI: "+expected,failure);
    }
    private void click(String xpath){onWebView().withElement(findElement(Locator.XPATH,xpath)).perform(webClick());}
    private void fill(String name,String value){onWebView().withElement(findElement(Locator.CSS_SELECTOR,"[name='"+name+"']")).perform(clearElement()).perform(webKeys(value));}
    private String http(String path,int expected)throws Exception{
        HttpURLConnection connection=(HttpURLConnection)new URL("https://localhost:34472"+path).openConnection();
        connection.setRequestProperty("Cache-Control","no-cache");connection.setConnectTimeout(10000);connection.setReadTimeout(10000);
        assertEquals("Independent HTTPS response",expected,connection.getResponseCode());
        return new String((expected<400?connection.getInputStream():connection.getErrorStream()).readAllBytes(),StandardCharsets.UTF_8);
    }
    private void menuReady()throws Exception {
        for(int i=0;i<40;i++){try{onWebView().withElement(findElement(Locator.XPATH,"//button[@aria-label='Menu']")).check(webMatches(getText(),containsString("")));return;}catch(Throwable pending){Thread.sleep(500);}}
        throw new AssertionError("Hosted navigation not ready");
    }
    private void resume()throws Exception{
        menuReady();
        click("//button[@aria-label='Menu']");click("//a[normalize-space(.)='Resume']");text("Fictional Android Candidate");
    }
    private void edit(String value)throws Exception{
        click("//button[@aria-label='Edit Fictional Android Candidate']");fill("summary",value);
        click("//form[@id='resume-inline-editor']//button[@type='submit']");text("Saved profile and summary.");
    }
    @Test public void signupCreateAndEdit()throws Exception{
        text("Sign in");click("//a[normalize-space(.)='Sign in']");text("Email address");fill("email","mobile-owner@phone-qa.invalid");
        click("//button[@type='submit']");text("If that address is invited");
        String link="";for(int i=0;i<30;i++){link=http("/__qa_link",200);if(!link.isEmpty())break;Thread.sleep(200);}
        assertFalse("Actual SMTP message must arrive",link.isEmpty());
        device.wait(Until.findObject(By.desc("Open sign-in link")),10000).click();
        device.wait(Until.findObject(By.clazz("android.widget.EditText")),10000).setText(link);
        device.findObject(By.res("android:id/button1")).click();link="";
        text("Finish signing in");click("//button[@type='submit']");text("Save private setup");
        fill("name","Fictional Android Candidate");fill("title","Fictional Android Engineer");fill("summary","Synthetic Android resume created through the real app.");
        click("//form[contains(@class,'onboarding-form')]/button[@type='submit']");text("Saved private onboarding data");resume();shot("android-created");
        edit("Synthetic Android resume edited and saved.");shot("android-edited");
        System.out.println("QA_PROOF real-email native-dialog hosted-confirmation create edit saved");
    }
    @Test public void relaunchPublishPrivateEditAndWithdraw()throws Exception{
        text("Open your workspace");click("//a[normalize-space(.)='Open your workspace']");menuReady();resume();
        text("Synthetic Android resume edited and saved.");shot("android-relaunch-persisted");
        click("//a[normalize-space(.)='Manage public profile']");text("Public handle");fill("handle","android-phone-qa-372");
        click("//button[normalize-space(.)='Generate preview']");text("Publish this version");shot("android-preview");
        click("//button[normalize-space(.)='Publish this version']");text("Published");shot("android-published");
        String publicPage=http("/people/android-phone-qa-372/",200);
        assertTrue(publicPage.contains("Fictional Android Candidate"));assertTrue(publicPage.contains("Synthetic Android resume edited and saved."));assertFalse(publicPage.contains("mobile-owner@phone-qa.invalid"));
        resume();edit("PRIVATE ANDROID MATERIAL must stay unpublished.");
        publicPage=http("/people/android-phone-qa-372/",200);assertFalse(publicPage.contains("PRIVATE ANDROID MATERIAL"));assertTrue(publicPage.contains("Synthetic Android resume edited and saved."));
        click("//a[normalize-space(.)='Manage public profile']");text("Unpublish profile");click("//button[normalize-space(.)='Unpublish profile']");text("Your previous public profile is unpublished");http("/people/android-phone-qa-372/",404);shot("android-unpublished");
        System.out.println("QA_PROOF native-relaunch persisted real-pdf-preview published anonymous-selected-only private-edit-absent withdrawn404");
    }
}

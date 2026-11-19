package us.jobgeni.app;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import androidx.appcompat.app.AlertDialog;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WebView web=getBridge().getWebView();
        ((ViewGroup)web.getParent()).removeView(web);
        LinearLayout content=new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        Button open=new Button(this);
        open.setText("Open sign-in link");open.setContentDescription("Open sign-in link");
        open.setOnClickListener(view->openSignInLink());
        content.addView(open,new LinearLayout.LayoutParams(-1,(int)(48*getResources().getDisplayMetrics().density)));
        content.addView(web,new LinearLayout.LayoutParams(-1,0,1));
        ViewCompat.setOnApplyWindowInsetsListener(content,(view,insets)->{
            Insets bars=insets.getInsets(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left,bars.top,bars.right,bars.bottom);return insets;
        });
        setContentView(content);
    }
    private void openSignInLink() {
        EditText input=new EditText(this);
        input.setHint("Paste your emailed JobGenius sign-in link");input.setContentDescription("Sign-in link");
        input.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setSaveEnabled(false);
        if(android.os.Build.VERSION.SDK_INT>=26) input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        new AlertDialog.Builder(this).setTitle("Open your sign-in link")
            .setMessage("Copy the link from your JobGenius email, then paste it here. You will confirm sign-in on JobGenius.")
            .setView(input).setNegativeButton("Cancel",(dialog,which)->input.setText(""))
            .setPositiveButton("Open",(dialog,which)->{
                String value=input.getText().toString();input.setText("");
                String origin=BuildConfig.DEBUG?getBridge().getServerUrl():"https://jobgeni.us";
                String url=SignInLink.destination(value,origin==null?"https://jobgeni.us":origin);
                if(url==null) new AlertDialog.Builder(this).setTitle("Use a JobGenius sign-in link")
                    .setMessage("Paste the HTTPS sign-in link from your JobGenius email.").setPositiveButton("OK",null).show();
                else getBridge().getWebView().loadUrl(url);
            }).show();
    }
}

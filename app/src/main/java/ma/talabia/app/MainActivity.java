package ma.talabia.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.os.Handler;
import android.os.Looper;
import android.os.Parcelable;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/** Talabia: shows the app (assets/index.html) full screen. */
public class MainActivity extends Activity {

    private static final int GREEN = Color.parseColor("#0f6b4f");
    private WebView web;
    private View topBar, bottomBar;
    private Object backCallback; // OnBackInvokedCallback on Android 13+
    private static final int PICK_FILE = 1001;
    private static final int MAX_SHARE_BYTES = 10 * 1024 * 1024;
    private ValueCallback<Uri[]> fileCallback;  // waiting for the photo / voice note picker
    private boolean pageReady = false;
    private String pendingShare;                // something shared to Talabia before the page was ready

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();

        // Layout: green strip under the status bar, the app, white strip above the navigation bar.
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        topBar = new View(this);
        topBar.setBackgroundColor(GREEN);
        bottomBar = new View(this);
        bottomBar.setBackgroundColor(Color.WHITE);
        web = new WebView(this);
        root.addView(topBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0));
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(bottomBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0));

        if (Build.VERSION.SDK_INT >= 30) {
            // Draw edge to edge (required from Android 15) and keep content clear of bars and keyboard.
            window.setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                setHeight(topBar, bars.top);
                setHeight(bottomBar, Math.max(bars.bottom, ime.bottom));
                v.setPadding(bars.left, 0, bars.right, 0);
                return WindowInsets.CONSUMED;
            });
            WindowInsetsController c = window.getInsetsController();
            if (c != null) {
                // Light icons on the green status bar, dark icons on the white navigation bar.
                c.setSystemBarsAppearance(WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            }
        } else {
            window.setStatusBarColor(GREEN);
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setTextZoom(100);

        web.addJavascriptInterface(new Bridge(this), "TalabiaAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openOutside(request.getUrl());
            }
            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openOutside(Uri.parse(url));
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                if (pendingShare != null) {
                    final String js = pendingShare;
                    pendingShare = null;
                    new Handler(Looper.getMainLooper()).postDelayed(() -> deliverShare(js), 900);
                }
            }
        });

        // Lets the page open the phone's picker for a screenshot or a voice note.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        setContentView(root);
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl("file:///android_asset/index.html");
        if (savedInstanceState == null) handleShare(getIntent());

        // Back button / back gesture: go back inside the app first.
        if (Build.VERSION.SDK_INT >= 33) {
            android.window.OnBackInvokedCallback cb = this::handleBack;
            backCallback = cb;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShare(intent);
    }

    @SuppressWarnings("deprecation")
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    /** "Share → Talabia" from WhatsApp or Instagram: a message, a screenshot or a voice note. */
    private void handleShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        final String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        final Uri uri = sharedUri(intent);
        final String type = intent.getType();
        intent.setAction(Intent.ACTION_MAIN); // handle it only once
        new Thread(() -> {
            try {
                JSONObject o = new JSONObject();
                if (text != null) o.put("text", text);
                if (uri != null) {
                    String mime = getContentResolver().getType(uri);
                    if (mime == null) mime = type;
                    byte[] bytes = readAll(uri);
                    if (bytes == null) {
                        runOnUiThread(() -> Toast.makeText(this, "This file is too big for Talabia (10 MB max)", Toast.LENGTH_LONG).show());
                        return;
                    }
                    o.put("mime", mime == null ? "application/octet-stream" : mime);
                    o.put("name", uri.getLastPathSegment());
                    o.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                }
                final String js = o.toString();
                runOnUiThread(() -> {
                    if (pageReady) deliverShare(js);
                    else pendingShare = js;
                });
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "Talabia couldn't open what you shared", Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    @SuppressWarnings("deprecation")
    private static Uri sharedUri(Intent intent) {
        Parcelable p = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                : intent.getParcelableExtra(Intent.EXTRA_STREAM);
        return p instanceof Uri ? (Uri) p : null;
    }

    private byte[] readAll(Uri uri) throws Exception {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return new byte[0];
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_SHARE_BYTES) return null;
            }
            return out.toByteArray();
        }
    }

    private void deliverShare(String json) {
        web.evaluateJavascript("window.talabiaShared && window.talabiaShared(" + json + ")", null);
    }

    private static void setHeight(View v, int h) {
        ViewGroup.LayoutParams lp = v.getLayoutParams();
        if (lp.height != h) { lp.height = h; v.setLayoutParams(lp); }
    }

    private void handleBack() {
        web.evaluateJavascript("(window.talabiaBack && window.talabiaBack()) ? 'yes' : 'no'", value -> {
            if (value != null && value.contains("yes")) return;
            if (web.canGoBack()) web.goBack();
            else finish();
        });
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBack(); // Android 12 and older
    }

    /** WhatsApp, Instagram and other links open in their own apps. */
    private boolean openOutside(Uri uri) {
        if (uri == null || "file".equals(uri.getScheme())) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) { }
        return true;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback((android.window.OnBackInvokedCallback) backCallback);
        }
        super.onDestroy();
    }

    /** Lets the page copy the confirmation message to the clipboard. */
    static class Bridge {
        private final Context ctx;
        Bridge(Context c) { ctx = c; }

        /** Which store installed the app ("com.android.vending" = Google Play), or "" when installed by hand. */
        @JavascriptInterface
        public String installer() {
            try {
                String pkg = ctx.getPackageName();
                String who;
                if (Build.VERSION.SDK_INT >= 30) who = ctx.getPackageManager().getInstallSourceInfo(pkg).getInstallingPackageName();
                else who = ctx.getPackageManager().getInstallerPackageName(pkg);
                return who == null ? "" : who;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void copy(String text) {
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Talabia", text));
        }
    }
}

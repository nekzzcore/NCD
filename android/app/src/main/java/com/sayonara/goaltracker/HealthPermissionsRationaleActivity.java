package com.sayonara.goaltracker;

import android.app.Activity;
import android.os.Bundle;
import android.text.method.LinkMovementMethod;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Local, offline rationale shown from the Health Connect permission screen. */
public class HealthPermissionsRationaleActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(padding, padding, padding, padding);
        layout.setLayoutParams(new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView title = new TextView(this);
        title.setText("NCD и Health Connect");
        title.setTextSize(24);
        title.setPadding(0, 0, 0, padding / 2);
        layout.addView(title);

        TextView body = new TextView(this);
        body.setText("NCD читает шаги, пульс, сон и вес только после вашего разрешения. " +
            "Последние полученные значения сохраняются локально на устройстве для офлайн-показа. " +
            "Показатели не отправляются в облако, не используются для диагностики и могут быть удалены " +
            "на вкладке «Здоровье». Доступ можно отозвать там же или в настройках Health Connect.");
        body.setTextSize(16);
        body.setLineSpacing(0, 1.25f);
        body.setMovementMethod(LinkMovementMethod.getInstance());
        layout.addView(body);
        setContentView(layout);
    }
}

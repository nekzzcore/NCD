package com.sayonara.goaltracker;

import android.os.Bundle;
import android.os.Build;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HealthConnectPlugin.class);
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // The HTML splash owns all timing and animation; remove the OS cover immediately.
            getSplashScreen().setOnExitAnimationListener(splashScreenView -> splashScreenView.remove());
        }
    }
}

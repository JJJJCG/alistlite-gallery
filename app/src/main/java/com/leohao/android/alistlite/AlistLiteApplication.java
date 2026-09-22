package com.leohao.android.alistlite;

import android.app.Application;
import android.content.Context;

/**
 * @author LeoHao
 */
public class AlistLiteApplication extends Application {
    public static Context applicationContext;

    @Override
    public void onCreate() {
        super.onCreate();
        AlistLiteApplication.applicationContext = this.getApplicationContext();
    }
}

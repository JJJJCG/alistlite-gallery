package com.leohao.android.alistlite.util;

import android.Manifest;
import com.hjq.permissions.Permission;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * @author LeoHao
 */
public class Constants {
    public static String OPENLIST_VERSION = "4.2.6";
    public static String ALIST_CONFIG_FILENAME = "config.json";
    public static String ALIST_STORAGE_DRIVER_MOUNT_PATH = "本地存储";
    public static String ALIST_DEFAULT_PASSWORD = "123456";
    public static Integer RECENT_RELEASE_RECORD_SIZE = 10;
    public static String ANDROID_PERMISSION_PREFIX = "android.permission.";
    public static String URL_RELEASE_LATEST = "https://api.github.com/repos/LeoHaoVIP/AListLiteAndroid/releases/latest";
    public static String URL_RELEASES = "https://api.github.com/repos/LeoHaoVIP/AListLiteAndroid/releases";
    public static String URL_OPEN_ISSUE = "https://github.com/LeoHaoVIP/AListLiteAndroid/issues";
    public static String URL_OPEN_DISCUSSION = "https://github.com/LeoHaoVIP/AListLiteAndroid/discussions";
    public static String URL_LOCAL_ABOUT_ALIST_LITE = "file:///android_asset/html/about-alistlite.html";
    public static String URL_LOCAL_RELEASE_LOG = "file:///android_asset/html/release-log.html";
    public static String URL_ABOUT_BLANK = "about:blank";
    public static String QUICK_DOWNLOAD_ADDRESS = "https://gitee.com/leohaovip/AListLiteAndroid/releases/download";
    public static String QUICK_DOWNLOAD_ADDRESS_GH_PROXY_PREFIX = "https://gh-proxy.org";
    public static String ERROR_MSG_CONFIG_DATA_READ = "{\"info\":\"无法读取配置，请检查存储权限\",\"msg\":\"MSG\"}";
    public static String ERROR_MSG_CONFIG_DATA_WRITE = "配置更新失败";
    public static String ANDROID_SHARED_DATA_PREFERENCES_NAME = "USER_INFO";
    public static String ANDROID_SHARED_DATA_KEY_ALIST_INITIALIZED = "alist_initialized";
    public static String ANDROID_SHARED_DATA_KEY_ADMIN_PASSWORD = "admin_password";
    public static String UNIVERSAL_ABI_NAME = "universal";
    public static String VERSION_INFO = "AListLite v%s | Powered by OpenList v%s";
    public static List<String> SUPPORTED_DOWNLOAD_ABI_NAMES = Arrays.asList("x86", "armeabi-v7a", "x86_64", "arm64-v8a");
    public static Map<String, String> permissionDescriptionMap = new HashMap<>();

    static {
        // 只保留「读取本地文件」相关的权限项。
        // 通知、忽略电池优化、开机自启都属于后台运行相关权限，不再申请、也不再在权限页列出。
        permissionDescriptionMap.put(Permission.READ_EXTERNAL_STORAGE, "用于挂载本地存储，关闭此项可能导致本地存储挂载成功但无权限访问（Android 13 版本以上用户可忽略该权限）");
        permissionDescriptionMap.put(Permission.READ_MEDIA_IMAGES, "用于挂载本地存储（Android 12 新特性），关闭此项可能导致本地存储挂载成功但无权限访问");
        permissionDescriptionMap.put(Permission.READ_MEDIA_VIDEO, "用于挂载本地存储（Android 12 新特性），关闭此项可能导致本地存储挂载成功但无权限访问");
        permissionDescriptionMap.put(Permission.READ_MEDIA_AUDIO, "用于挂载本地存储（Android 12 新特性），关闭此项可能导致本地存储挂载成功但无权限访问");
        permissionDescriptionMap.put(Permission.WRITE_EXTERNAL_STORAGE, "用于挂载本地存储，关闭此项可能导致本地存储挂载成功但无权限进行文件管理操作");
        permissionDescriptionMap.put(Permission.MANAGE_EXTERNAL_STORAGE, "用于挂载本地存储（Android 11 新特性），关闭此项可能导致本地存储挂载成功但无权限进行文件管理操作");
    }
}

package com.snlookup

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * Registers the plugin's own native modules and views.
 *
 * Added by hand in MainApplication.getPackages: autolinking only sees packages
 * under node_modules, and PluginHost only loads what ends up in the
 * `reactPackages` array of PluginConfig.json — so a package that lives in this
 * app has to be named in both places or its native module is simply null at
 * runtime, with no build-time complaint.
 */
class LogPackage : ReactPackage {

  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    // Earliest hook the plugin controls: the bridge is still being built, so no
    // view — and therefore no WebView — can exist yet.
    Bootstrap.install()
    return listOf(
        LogModule(reactContext),
        WebModule(reactContext),
        ClipModule(reactContext),
        SettingsModule(reactContext),
    )
  }

  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<out View, out ReactShadowNode<*>>> = emptyList()
}

package build.openbot.one

import android.os.Bundle
import android.content.Context
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private external fun initCertificateVerifier(context: Context)

  override fun onCreate(savedInstanceState: Bundle?) {
    System.loadLibrary("openbot_one")
    initCertificateVerifier(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}

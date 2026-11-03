package app.ompr.service

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.ompr.MainActivity
import app.ompr.R
import app.ompr.data.AttentionItem
import app.ompr.data.AttentionKinds
import app.ompr.data.SettingsStore

/** Local notifications: one channel per attention kind plus the foreground-service channel. */
class Notifier(private val context: Context, private val settings: SettingsStore, private val presence: Presence) {
    private val nm = NotificationManagerCompat.from(context)

    init {
        createChannels()
    }

    private fun createChannels() {
        val sys = context.getSystemService(NotificationManager::class.java)
        fun ch(id: String, name: String, desc: String, importance: Int) {
            sys.createNotificationChannel(NotificationChannel(id, name, importance).apply { description = desc })
        }
        ch(CH_APPROVAL, context.getString(R.string.channel_approval), context.getString(R.string.channel_approval_desc), NotificationManager.IMPORTANCE_HIGH)
        ch(CH_QUESTION, context.getString(R.string.channel_question), context.getString(R.string.channel_question_desc), NotificationManager.IMPORTANCE_HIGH)
        ch(CH_DONE, context.getString(R.string.channel_done), context.getString(R.string.channel_done_desc), NotificationManager.IMPORTANCE_DEFAULT)
        ch(CH_ERROR, context.getString(R.string.channel_error), context.getString(R.string.channel_error_desc), NotificationManager.IMPORTANCE_DEFAULT)
        ch(CH_LIMIT, context.getString(R.string.channel_limit), context.getString(R.string.channel_limit_desc), NotificationManager.IMPORTANCE_DEFAULT)
        ch(CH_CONNECTION, context.getString(R.string.channel_connection), context.getString(R.string.channel_connection_desc), NotificationManager.IMPORTANCE_MIN)
        ch(CH_TOOL_REQUEST, context.getString(R.string.channel_tool_request), context.getString(R.string.channel_tool_request_desc), NotificationManager.IMPORTANCE_HIGH)
        ch(CH_AGENT_MESSAGE, context.getString(R.string.channel_agent_message), context.getString(R.string.channel_agent_message_desc), NotificationManager.IMPORTANCE_DEFAULT)
    }

    fun channelFor(kind: String): String = when (kind) {
        AttentionKinds.APPROVAL -> CH_APPROVAL
        AttentionKinds.QUESTION -> CH_QUESTION
        AttentionKinds.ERROR -> CH_ERROR
        AttentionKinds.LIMIT -> CH_LIMIT
        else -> CH_DONE
    }

    fun canPost(): Boolean = android.os.Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun tag(hostId: String, itemId: String) = "attn:$hostId:$itemId"

    private fun openIntent(hostId: String, sid: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = MainActivity.ACTION_OPEN_SESSION
            data = Uri.parse("ompr://open/$hostId/$sid")
            putExtra(MainActivity.EXTRA_HOST_ID, hostId)
            putExtra(MainActivity.EXTRA_SID, sid)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun kindTitle(kind: String): String = context.getString(
        when (kind) {
            AttentionKinds.APPROVAL -> R.string.attn_approval
            AttentionKinds.QUESTION -> R.string.attn_question
            AttentionKinds.ERROR -> R.string.attn_error
            AttentionKinds.LIMIT -> R.string.attn_limit
            else -> R.string.attn_done
        },
    )

    /** Posts a notification for [item] unless that kind is switched off, the user is looking at the session, or permission is missing. */
    suspend fun showAttention(hostId: String, hostName: String, item: AttentionItem) {
        if (item.resolved) return
        if (!settings.isNotifyEnabled(item.kind)) return
        if (presence.isViewing(hostId, item.sid)) { Log.i("OmprAttn", "suppressed: session on screen"); return }
        if (!canPost()) { Log.i("OmprAttn", "suppressed: no notification permission"); return }
        val title = "${kindTitle(item.kind)} · ${item.sessionTitle.ifBlank { hostName }}"
        // On the lock screen only the kind is visible ("OMP Remote: approval needed"), never session titles or commands.
        val redacted = NotificationCompat.Builder(context, channelFor(item.kind))
            .setSmallIcon(R.drawable.ic_stat_ompr)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(kindTitle(item.kind))
            .build()
        val n = NotificationCompat.Builder(context, channelFor(item.kind))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(redacted)
            .setSmallIcon(R.drawable.ic_stat_ompr)
            .setContentTitle(title)
            .setContentText(item.summary)
            .setStyle(NotificationCompat.BigTextStyle().bigText(item.summary).setSummaryText(hostName))
            .setContentIntent(openIntent(hostId, item.sid))
            .setAutoCancel(true)
            .setCategory(
                if (item.kind == AttentionKinds.APPROVAL || item.kind == AttentionKinds.QUESTION) Notification.CATEGORY_MESSAGE else Notification.CATEGORY_STATUS,
            )
            .setWhen(item.ts.takeIf { it > 0 } ?: System.currentTimeMillis())
            .setGroup("host:$hostId")
            .addExtras(android.os.Bundle().apply { putString("ompr.sid", item.sid) })
            .build()
        runCatching { nm.notify(tag(hostId, item.id), 1, n) }
    }

    fun cancelAttention(hostId: String, itemId: String) {
        nm.cancel(tag(hostId, itemId), 1)
    }

    /** Cancel every notification of [sid] on this host (the user opened it). */
    fun cancelForSession(hostId: String, sid: String) {
        val sys = context.getSystemService(NotificationManager::class.java)
        for (sbn in sys.activeNotifications) {
            val t = sbn.tag ?: continue
            if (!t.startsWith("attn:$hostId:")) continue
            if (sbn.notification.extras.getString("ompr.sid") == sid) nm.cancel(t, sbn.id)
        }
    }

    /** The persistent foreground-service notification. */
    fun foregroundNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            context, 1, Intent(context, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            context, 2, Intent(context, ConnectionService::class.java).setAction(ConnectionService.ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val redacted = NotificationCompat.Builder(context, CH_CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_ompr)
            .setContentTitle(context.getString(R.string.app_name))
            .build()
        return NotificationCompat.Builder(context, CH_CONNECTION)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(redacted)
            .setSmallIcon(R.drawable.ic_stat_ompr)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, context.getString(R.string.stop), stop)
            .build()
    }

    fun updateForeground(text: String) {
        if (!canPost()) return
        runCatching { nm.notify(ConnectionService.NOTIFICATION_ID, foregroundNotification(text)) }
    }

    private val agentSeq = java.util.concurrent.atomic.AtomicInteger()

    private fun openAppIntent(requestCode: Int): PendingIntent = PendingIntent.getActivity(
        context, requestCode,
        Intent(context, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /**
     * A phone tool needs the app on screen (camera, clipboard, location) or the user's confirmation, but the app is in the
     * background. Tapping it opens the app, where the pending question or tool call is picked up. The lock-screen version is generic.
     */
    fun showToolWaiting(action: String, hostName: String) {
        if (!canPost()) return
        val redacted = NotificationCompat.Builder(context, CH_TOOL_REQUEST)
            .setSmallIcon(R.drawable.ic_stat_ompr)
            .setContentTitle(context.getString(R.string.tool_waiting_public))
            .build()
        val n = NotificationCompat.Builder(context, CH_TOOL_REQUEST)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(redacted)
            .setSmallIcon(R.drawable.ic_stat_ompr)
            .setContentTitle(context.getString(R.string.tool_waiting_title, action))
            .setContentText(context.getString(R.string.tool_waiting_text, hostName))
            .setContentIntent(openAppIntent(3))
            .setAutoCancel(true)
            .setTimeoutAfter(TOOL_WAIT_MS)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        runCatching { nm.notify(TOOL_WAITING_TAG, 2, n) }
    }

    fun cancelToolWaiting() {
        nm.cancel(TOOL_WAITING_TAG, 2)
    }

    /** `phone_notify`: a message the agent wants the user to see. Returns false when it could not be posted. */
    fun showAgentMessage(title: String, message: String): Boolean {
        if (!canPost()) return false
        val redacted = NotificationCompat.Builder(context, CH_AGENT_MESSAGE)
            .setSmallIcon(R.drawable.ic_stat_ompr)
            .setContentTitle(context.getString(R.string.agent_message_public))
            .build()
        val n = NotificationCompat.Builder(context, CH_AGENT_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(redacted)
            .setSmallIcon(R.drawable.ic_stat_ompr)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setContentIntent(openAppIntent(4))
            .setAutoCancel(true)
            .build()
        return runCatching { nm.notify("agent", agentSeq.incrementAndGet(), n) }.isSuccess
    }

    companion object {
        const val CH_APPROVAL = "attention_approval"
        const val CH_QUESTION = "attention_question"
        const val CH_DONE = "attention_done"
        const val CH_ERROR = "attention_error"
        const val CH_LIMIT = "attention_limit"
        const val CH_CONNECTION = "connection"
        const val CH_TOOL_REQUEST = "tool_request"
        const val CH_AGENT_MESSAGE = "agent_message"
        private const val TOOL_WAITING_TAG = "tool_waiting"
        private const val TOOL_WAIT_MS = 60_000L
    }
}

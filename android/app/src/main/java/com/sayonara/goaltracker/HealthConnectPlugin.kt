package com.sayonara.goaltracker

import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

@CapacitorPlugin(name = "HealthConnect")
class HealthConnectPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var pendingPermissionCall: PluginCall? = null
    private lateinit var permissionLauncher: ActivityResultLauncher<Set<String>>

    private val permissionByType = linkedMapOf(
        "steps" to HealthPermission.getReadPermission(StepsRecord::class),
        "heartRate" to HealthPermission.getReadPermission(HeartRateRecord::class),
        "sleep" to HealthPermission.getReadPermission(SleepSessionRecord::class),
        "weight" to HealthPermission.getReadPermission(WeightRecord::class)
    )

    override fun load() {
        permissionLauncher = activity.activityResultRegistry.register(
            "goaltracker-health-connect-permissions",
            activity,
            PermissionController.createRequestPermissionResultContract()
        ) { granted ->
            val call = pendingPermissionCall ?: return@register
            pendingPermissionCall = null
            call.resolve(permissionResult(granted))
        }
    }

    @PluginMethod
    fun getAvailability(call: PluginCall) {
        val status = when (HealthConnectClient.getSdkStatus(context)) {
            HealthConnectClient.SDK_AVAILABLE -> "available"
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "updateRequired"
            else -> "unavailable"
        }
        call.resolve(JSObject().put("status", status))
    }

    @PluginMethod
    fun getPermissions(call: PluginCall) = withAvailableClient(call) { client ->
        call.resolve(permissionResult(client.permissionController.getGrantedPermissions()))
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        if (HealthConnectClient.getSdkStatus(context) != HealthConnectClient.SDK_AVAILABLE) {
            call.resolve(JSObject().put("granted", JSArray()).put("status", "unavailable"))
            return
        }
        if (pendingPermissionCall != null) {
            call.reject("Запрос разрешений уже открыт", "REQUEST_IN_PROGRESS")
            return
        }
        pendingPermissionCall = call
        activity.runOnUiThread { permissionLauncher.launch(permissionByType.values.toSet()) }
    }

    @PluginMethod
    fun readLatest(call: PluginCall) = withAvailableClient(call) { client ->
        val granted = client.permissionController.getGrantedPermissions()
        val metrics = JSObject()
        val now = Instant.now()
        val zone = ZoneId.systemDefault()

        if (granted.contains(permissionByType.getValue("steps"))) {
            val start = LocalDate.now(zone).atStartOfDay(zone).toInstant()
            val aggregate = client.aggregate(
                AggregateRequest(setOf(StepsRecord.COUNT_TOTAL), TimeRangeFilter.between(start, now))
            )
            aggregate[StepsRecord.COUNT_TOTAL]?.let { count ->
                metrics.put("steps", metric(count.toDouble(), "count", sourceNames(aggregate.dataOrigins), now))
            }
        }

        if (granted.contains(permissionByType.getValue("heartRate"))) {
            val records = client.readRecords(
                ReadRecordsRequest(HeartRateRecord::class, TimeRangeFilter.between(now.minus(Duration.ofDays(1)), now), ascendingOrder = false)
            ).records
            val latest = records.flatMap { record -> record.samples.map { sample -> Triple(sample.time, sample.beatsPerMinute, record) } }
                .maxByOrNull { it.first }
            latest?.let { (time, bpm, record) ->
                metrics.put("heartRate", metric(bpm.toDouble(), "bpm", sourceName(record.metadata.dataOrigin.packageName), time))
            }
        }

        if (granted.contains(permissionByType.getValue("sleep"))) {
            val record = client.readRecords(
                ReadRecordsRequest(SleepSessionRecord::class, TimeRangeFilter.between(now.minus(Duration.ofDays(7)), now), ascendingOrder = false)
            ).records.maxByOrNull { it.endTime }
            record?.let {
                val minutes = Duration.between(it.startTime, it.endTime).toMinutes().toDouble()
                metrics.put("sleep", metric(minutes, "minutes", sourceName(it.metadata.dataOrigin.packageName), it.endTime))
            }
        }

        if (granted.contains(permissionByType.getValue("weight"))) {
            val record = client.readRecords(
                ReadRecordsRequest(WeightRecord::class, TimeRangeFilter.between(now.minus(Duration.ofDays(30)), now), ascendingOrder = false)
            ).records.maxByOrNull { it.time }
            record?.let {
                metrics.put("weight", metric(it.weight.inKilograms, "kg", sourceName(it.metadata.dataOrigin.packageName), it.time))
            }
        }

        call.resolve(JSObject().put("metrics", metrics))
    }

    @PluginMethod
    fun revokePermissions(call: PluginCall) = withAvailableClient(call) { client ->
        client.permissionController.revokeAllPermissions()
        call.resolve()
    }

    private fun withAvailableClient(call: PluginCall, block: suspend (HealthConnectClient) -> Unit) {
        if (HealthConnectClient.getSdkStatus(context) != HealthConnectClient.SDK_AVAILABLE) {
            call.reject("Health Connect недоступен", "HEALTH_CONNECT_UNAVAILABLE")
            return
        }
        scope.launch {
            try {
                block(HealthConnectClient.getOrCreate(context))
            } catch (_: SecurityException) {
                call.reject("Нет разрешения на чтение", "PERMISSION_DENIED")
            } catch (_: Exception) {
                call.reject("Не удалось прочитать Health Connect", "READ_FAILED")
            }
        }
    }

    private fun permissionResult(granted: Set<String>): JSObject {
        val names = JSArray()
        permissionByType.forEach { (type, permission) -> if (granted.contains(permission)) names.put(type) }
        return JSObject().put("granted", names)
    }

    private fun metric(value: Double, unit: String, source: String, measuredAt: Instant): JSObject =
        JSObject().put("value", value).put("unit", unit).put("source", source).put("measuredAt", measuredAt.toString())

    private fun sourceNames(origins: Set<androidx.health.connect.client.records.metadata.DataOrigin>): String =
        origins.map { sourceName(it.packageName) }.distinct().joinToString(", ")

    private fun sourceName(packageName: String): String = try {
        val info = context.packageManager.getApplicationInfo(packageName, 0)
        context.packageManager.getApplicationLabel(info).toString()
    } catch (_: Exception) {
        packageName
    }

    override fun handleOnDestroy() {
        pendingPermissionCall = null
        if (::permissionLauncher.isInitialized) permissionLauncher.unregister()
        scope.cancel()
        super.handleOnDestroy()
    }
}

package app.ompr.ui.files

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Difference
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import app.ompr.R
import app.ompr.data.Features
import app.ompr.data.supports
import app.ompr.net.HostConnection

/**
 * Overflow menu for a session's top bar: "Files" and "Changes" for the session's working directory.
 * Each entry appears only when the connected host lists the feature (older bridges do not); with none, nothing is drawn.
 */
@Composable
fun SessionFilesMenu(conn: HostConnection, cwd: String?, onOpenFiles: (String) -> Unit, onOpenChanges: (String) -> Unit) {
    val info by conn.info.collectAsState()
    val files = info.supports(Features.FILES)
    val git = info.supports(Features.GIT)
    if (!files && !git) return
    var open by remember { mutableStateOf(false) }
    val dir = cwd?.takeIf { it.isNotBlank() }
    IconButton(onClick = { open = true }, enabled = dir != null) { Icon(Icons.Filled.MoreVert, "More") }
    DropdownMenu(open, { open = false }) {
        if (files && dir != null) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.menu_files)) },
                leadingIcon = { Icon(Icons.Filled.Folder, null) },
                onClick = { open = false; onOpenFiles(dir) },
            )
        }
        if (git && dir != null) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.menu_changes)) },
                leadingIcon = { Icon(Icons.Filled.Difference, null) },
                onClick = { open = false; onOpenChanges(dir) },
            )
        }
    }
}

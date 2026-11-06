package app.ompr.ui.files

import app.ompr.net.WireException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FileLogicTest {
    @Test
    fun decodesStatusCodes() {
        val m = StatusCode(" M")
        assertEquals(ChangeKind.MODIFIED, m.kind)
        assertTrue(m.unstaged); assertFalse(m.staged)
        assertEquals("Modified", m.label)

        val a = StatusCode("A ")
        assertEquals(ChangeKind.ADDED, a.kind)
        assertTrue(a.staged); assertFalse(a.unstaged)
        assertEquals("A", a.badge)
        assertEquals("Added · staged", a.label)

        val mm = StatusCode("MM")
        assertTrue(mm.staged && mm.unstaged)
        assertEquals("M", mm.badge)
        assertEquals("Modified · staged + more edits", mm.label)

        assertEquals(ChangeKind.RENAMED, StatusCode("R ").kind)
        assertEquals(ChangeKind.DELETED, StatusCode(" D").kind)
        assertEquals(ChangeKind.DELETED, StatusCode("D ").kind)
        assertEquals(ChangeKind.TYPE_CHANGED, StatusCode(" T").kind)
        assertEquals(ChangeKind.UNKNOWN, StatusCode("").kind)
    }

    @Test
    fun untrackedIgnoredAndConflictsAreNeitherStagedNorUnstaged() {
        for (code in listOf("??", "!!", "UU", "AA", "DD", "AU", "UD")) {
            val c = StatusCode(code)
            assertFalse(code, c.staged); assertFalse(code, c.unstaged)
        }
        assertEquals(ChangeKind.UNTRACKED, StatusCode("??").kind)
        assertEquals("?", StatusCode("??").badge)
        assertEquals(ChangeKind.IGNORED, StatusCode("!!").kind)
        for (code in listOf("UU", "AA", "DD", "AU", "UD", "DU", "UA")) assertEquals(code, ChangeKind.CONFLICT, StatusCode(code).kind)
    }

    @Test
    fun opensTheStagedDiffOnlyWhenNothingIsUnstaged() {
        assertTrue(defaultStaged(StatusCode("A ")))
        assertFalse(defaultStaged(StatusCode(" M")))
        assertFalse(defaultStaged(StatusCode("MM")))
    }

    private fun kinds(diff: String) = parseDiff(diff).map { it.kind }

    @Test
    fun classifiesDiffLines() {
        val diff = """
            diff --git a/a.txt b/a.txt
            index 1111111..2222222 100644
            --- a/a.txt
            +++ b/a.txt
            @@ -1,3 +1,3 @@ fun main()
             keep
            -old
            +new
             tail
            \ No newline at end of file
        """.trimIndent() + "\n"
        assertEquals(
            listOf(
                DiffLineKind.HEADER, DiffLineKind.HEADER, DiffLineKind.HEADER, DiffLineKind.HEADER,
                DiffLineKind.HUNK, DiffLineKind.CONTEXT, DiffLineKind.REMOVED, DiffLineKind.ADDED, DiffLineKind.CONTEXT, DiffLineKind.NOTE,
            ),
            kinds(diff),
        )
    }

    @Test
    fun linesThatLookLikeFileHeadersInsideAHunkAreStillChanges() {
        // removed "-- sql comment" and added "++ x" read as `--- ` / `+++ ` but belong to the hunk
        val diff = "@@ -1,3 +1,3 @@\n--- sql comment\n+++ x\n ctx\n-gone\n+here\n"
        assertEquals(listOf(DiffLineKind.HUNK, DiffLineKind.REMOVED, DiffLineKind.ADDED, DiffLineKind.CONTEXT, DiffLineKind.REMOVED, DiffLineKind.ADDED), kinds(diff))
        // the next file's headers after the hunk are headers again
        val two = "@@ -1 +1 @@\n-a\n+b\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -0,0 +1 @@\n+c\n"
        assertEquals(
            listOf(
                DiffLineKind.HUNK, DiffLineKind.REMOVED, DiffLineKind.ADDED,
                DiffLineKind.HEADER, DiffLineKind.HEADER, DiffLineKind.HEADER, DiffLineKind.HUNK, DiffLineKind.ADDED,
            ),
            kinds(two),
        )
    }

    @Test
    fun aCutDiffAndBinaryNoticesDoNotBreakParsing() {
        assertTrue(parseDiff("").isEmpty())
        // hunk promises 5 lines, output stops after 2
        assertEquals(listOf(DiffLineKind.HUNK, DiffLineKind.ADDED, DiffLineKind.CONTEXT), kinds("@@ -1,5 +1,5 @@\n+a\n b"))
        assertEquals(DiffLineKind.HEADER, parseDiff("Binary files a/x and b/x differ\n").single().kind)
        // an empty line inside a hunk is a context line whose space was stripped
        assertEquals(listOf(DiffLineKind.HUNK, DiffLineKind.CONTEXT, DiffLineKind.ADDED), kinds("@@ -1,1 +1,2 @@\n\n+x\n"))
    }

    @Test
    fun splitsLinesWithoutAPhantomLastLine() {
        assertEquals(listOf("a", "b"), splitLines("a\nb\n"))
        assertEquals(listOf("a", "b"), splitLines("a\r\nb"))
        assertEquals(listOf("", "a"), splitLines("\na\n"))
        assertTrue(splitLines("").isEmpty())
        assertEquals(1, gutterDigits(0)); assertEquals(3, gutterDigits(100)); assertEquals(2, gutterDigits(99))
        assertEquals("abc", clipLine("abc", 5))
        assertEquals("ab… (+3 chars)", clipLine("abcde", 2))
    }

    @Test
    fun formatsSizesAndWalksPaths() {
        assertEquals("512 B", formatSize(512))
        assertEquals("1.5 KB", formatSize(1536))
        assertEquals("2.0 MB", formatSize(2 * 1024 * 1024))
        assertEquals("/a/b", parentOf("/a/b/c"))
        assertEquals("/a", parentOf("/a/b/"))
        assertEquals("/", parentOf("/a"))
        assertEquals("/", parentOf("/"))
        assertEquals("/a/b/c.txt", joinPath("/a/b/", "c.txt"))
        assertEquals("c", baseName("/a/b/c/"))
        assertEquals("/", baseName("/"))
        val roots = listOf("/home/me/code", "/srv/")
        assertFalse(canGoUp("/home/me/code", roots))
        assertFalse(canGoUp("/home/me/code/", roots))
        assertFalse(canGoUp("/srv", roots))
        assertTrue(canGoUp("/home/me/code/app", roots))
        assertTrue(canGoUp("/home/me/code/app", emptyList()))
    }

    @Test
    fun recognisesTheNotARepositoryError() {
        assertTrue(isNotRepository(WireException("invalid", "not a git repository")))
        assertFalse(isNotRepository(WireException("invalid", "git: something else")))
        assertFalse(isNotRepository(WireException("forbidden_path", "not a git repository")))
        assertFalse(isNotRepository(IllegalStateException("not a git repository")))
    }
}

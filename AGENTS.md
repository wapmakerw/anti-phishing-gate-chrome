# Agent Token Optimization Instructions

To minimize token usage and keep context windows compact, all AI agents working on this project must adhere to the following rules:

1. **Precision File Reading:**
   - On the first read of any file, read the whole file to understand it.
   - For all subsequent reads, use the `StartLine` and `EndLine` parameters of `view_file` to read only the lines you need to edit or review. Do not read the entire file again.

2. **Grep and List Constraints:**
   - Use `grep_search` with specific query parameters rather than reading files or listing directories recursively.
   - Keep directory listings focused on the immediate subdirectory of interest.

3. **Concise Communication:**
   - Write short, direct responses.
   - Do not re-summarize files, artifacts, or code edits unless specifically requested.
   - Point to the relevant files or artifacts using markdown links.

4. **Targeted Code Replacements:**
   - Use `replace_file_content` with the smallest possible contiguous range of lines.
   - Avoid replacing entire files when modifying code.

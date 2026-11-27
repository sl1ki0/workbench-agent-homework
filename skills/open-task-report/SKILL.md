---
name: open-task-report
description: Use for a report or summary of open tasks from the educational tracker, especially when the user wants a Markdown file based on live tracker records.
---

# Open task report

1. Request the tracker list through its MCP tool. If the active filter supports open tasks, set it in the request.
2. Review the response and keep records whose status is `open`. If the list fails, surface the source error and avoid inventing tasks.
3. Sort the records by task ID. Write a Markdown table with the requested columns. Preserve the IDs and titles from the tracker. Use plain ID text unless the user asks for links.
4. Save to the requested path and read the file back. Compare its rows against the filtered source, including the row count. In the reply give the path and the factual number of open tasks.

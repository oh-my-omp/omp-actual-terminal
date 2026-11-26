local function trimmed(value)
	return (value:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function language()
	local configured = tern.getenv("OMOMP_LANG")
	if configured then
		local normalized = trimmed(configured):lower()
		if normalized == "en" or normalized == "zh" then
			return normalized
		end
	end
	for _, name in ipairs({ "LC_ALL", "LC_MESSAGES", "LANG" }) do
		local value = tern.getenv(name)
		if value and trimmed(value) ~= "" then
			if trimmed(value):lower():sub(1, 2) == "zh" then
				return "zh"
			end
			return "en"
		end
	end
	return "en"
end

local chinese = language() == "zh"

local function focused_omp_agent(cx)
	local focused = cx.session:focused()
	if not focused then
		return nil
	end
	for _, agent in ipairs(cx.agents:list()) do
		if agent.pane == focused then
			return focused
		end
	end
	return nil
end

tern.command({
	id = "console",
	title = chinese and "omp：打开终端控制台" or "omp: Open terminal Console",
	run = function(cx)
		local pane = focused_omp_agent(cx)
		if pane then
			local sent, failure = pcall(function()
				cx.agents:ask(pane, "/terminals")
			end)
			if not sent then
				cx:toast("error", chinese and "omp 没有接收 /terminals" or "omp did not take /terminals", tostring(failure))
			end
			return
		end
		cx:toast("error", chinese and "没有聚焦的 omp 窗格" or "No omp pane is focused")
	end,
})

/* See license.txt for terms of usage */

define([
    "firebug/lib/object",
    "firebug/lib/locale",
    "firebug/lib/events",
    "firebug/lib/dom",
    "firebug/lib/array",
    "firebug/lib/css",
    "firebug/lib/domplate",
    "firebug/debugger/script/scriptView",
    "arch/compilationunit",
    "firebug/chrome/menu",
    "firebug/debugger/stack/stackFrame",
    "firebug/debugger/script/sourceLink",
    "firebug/debugger/breakpoint/breakpoint",
    "firebug/debugger/breakpoint/breakpointStore",
    "firebug/trace/traceModule",
    "firebug/trace/traceListener",
    "firebug/debugger/breakpoint/breakpointConditionEditor",
    "firebug/lib/keywords",
    "firebug/lib/system",
],
function (Obj, Locale, Events, Dom, Arr, Css, Domplate, ScriptView, CompilationUnit, Menu,
    StackFrame, SourceLink, Breakpoint, BreakpointStore, TraceModule, TraceListener,
    BreakpointConditionEditor, Keywords, System) {

// ********************************************************************************************* //
// Constants

var TraceError = FBTrace.to("DBG_ERRORS");
var Trace = FBTrace.to("DBG_SCRIPTPANEL");

// ********************************************************************************************* //
// Script panel

/**
 * @Panel This object represents the 'Script' panel that is used for debugging JavaScript.
 * This panel is using JSD2 API for debugging.
 */
function ScriptPanel() {}
var BasePanel = Firebug.ActivablePanel;
ScriptPanel.prototype = Obj.extend(BasePanel,
/** @lends ScriptPanel */
{
    dispatchName: "ScriptPanel",

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // extends Panel

    name: "script",
    searchable: true,
    breakable: true,
    enableA11y: true,
    order: 45,

    // Will appear in detached Firebug Remote XUL window.
    remotable: true,

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Initialization

    initialize: function(context, doc)
    {
        BasePanel.initialize.apply(this, arguments);

        // Custom tracing.
        this.traceListener = new TraceListener("scriptPanel.", "DBG_SCRIPTPANEL", false);
        TraceModule.addListener(this.traceListener);

        this.panelSplitter = Firebug.chrome.$("fbPanelSplitter");
        this.sidePanelDeck = Firebug.chrome.$("fbSidePanelDeck");

        // Create source view for JS source code. Initialization is made when the Script
        // panel is actualy displayed (in 'show' method).
        this.scriptView = new ScriptView();
        this.scriptView.addListener(this);

        // Listen to breakpoint changes (add/remove).
        BreakpointStore.addListener(this);

        // The tool/controller (serves as a proxy to the backend service) is registered dynamicaly.
        // Depending on the current tool the communication can be local or remote.
        // Access to the back-end debugger service (JSD2) must always be done through the tool.
        this.tool = this.context.getTool("debugger");
        this.tool.addListener(this);
    },

    destroy: function(state)
    {
        this.scriptView.removeListener(this);
        this.scriptView.destroy();

        BreakpointStore.removeListener(this);

        this.tool.removeListener(this);

        TraceModule.removeListener(this.traceListener);

        BasePanel.destroy.apply(this, arguments);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // extends ActivablePanel

    onActivationChanged: function(enable)
    {
        // xxxHonza: needs to be revisited
        if (enable)
        {
            Firebug.Debugger.addObserver(this);
        }
        else
        {
            Firebug.Debugger.removeObserver(this);
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Panel show/hide

    show: function(state)
    {
        var enabled = this.isEnabled();
        if (!enabled)
            return;

        Trace.sysout("scriptPanel.show;", state);

        // Initialize the source view. In case of Orion initialization here, when the 
        // parentNode is actualy visible, also solves Orion's problem:
        // Error: TypeError: this._iframe.contentWindow is undefined
        // Save for muliple calls.
        this.scriptView.initialize(this.panelNode);

        var active = true;

        // These buttons are visible only, if debugger is enabled.
        this.showToolbarButtons("fbLocationSeparator", active);
        this.showToolbarButtons("fbDebuggerButtons", active);
        this.showToolbarButtons("fbLocationButtons", active);
        this.showToolbarButtons("fbScriptButtons", active);
        this.showToolbarButtons("fbStatusButtons", active);

        Firebug.chrome.$("fbRerunButton").setAttribute("tooltiptext",
            Locale.$STRF("firebug.labelWithShortcut", [Locale.$STR("script.Rerun"), "Shift+F8"]));
        Firebug.chrome.$("fbContinueButton").setAttribute("tooltiptext",
            Locale.$STRF("firebug.labelWithShortcut", [Locale.$STR("script.Continue"), "F8"]));
        Firebug.chrome.$("fbStepIntoButton").setAttribute("tooltiptext",
            Locale.$STRF("firebug.labelWithShortcut", [Locale.$STR("script.Step_Into"), "F11"]));
        Firebug.chrome.$("fbStepOverButton").setAttribute("tooltiptext",
            Locale.$STRF("firebug.labelWithShortcut", [Locale.$STR("script.Step_Over"), "F10"]));
        Firebug.chrome.$("fbStepOutButton").setAttribute("tooltiptext",
            Locale.$STRF("firebug.labelWithShortcut",
                [Locale.$STR("script.Step_Out"), "Shift+F11"]));

        // Additional debugger panels are visible only, if debugger is active.
        this.panelSplitter.collapsed = !active;
        this.sidePanelDeck.collapsed = !active;
    },

    hide: function(state)
    {
    },

    showStackFrame: function(frame)
    {
        if (this.context.stopped)
            this.showStackFrameTrue(frame);
        else
            this.showNoStackFrame();
    },

    showStackFrameTrue: function(frame)
    {
        // Make sure the current frame seen by the user is set (issue 4818)
        // xxxHonza: Better solution (important for remoting)
        // Set this.context.currentFrame = frame (meaning frameXB) and pass the value of
        // frameXB during evaluation calls, causing the backend to select the appropriate
        // frame for frame.eval().
        //this.context.currentFrame = frame.nativeFrame;

        var url = frame.getURL();
        var lineNo = frame.getLineNumber();

        if (FBTrace.DBG_STACK)
            FBTrace.sysout("showStackFrame: " + url + "@" + lineNo);

        if (this.context.breakingCause)
            this.context.breakingCause.lineNo = lineNo;

        this.scrollToLine(url, lineNo/*, this.highlightLine(lineNo, this.context)*/);
        //this.context.throttle(this.updateInfoTip, this);
    },

    showNoStackFrame: function()
    {
        this.removeExeLineHighlight();

        // Clear the stack on the panel toolbar
        var panelStatus = Firebug.chrome.getPanelStatusElements();
        panelStatus.clear();

        this.updateInfoTip();

        var watchPanel = this.context.getPanel("watches", true);
        if (watchPanel)
            watchPanel.showEmptyMembers();
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Selection

    updateSelection: function(object)
    {
        if (FBTrace.DBG_PANELS)
        {
            FBTrace.sysout("script updateSelection object:" + object + " of type " +
                typeof(object), object);

            if (object instanceof CompilationUnit)
                FBTrace.sysout("script updateSelection this.navigate(object)", object);
            else if (object instanceof SourceLink)
                FBTrace.sysout("script updateSelection this.showSourceLink(object)", object);
            else if (typeof(object) == "function")
                FBTrace.sysout("script updateSelection this.showFunction(object)", object);
            else if (object instanceof StackFrame)
                FBTrace.sysout("script updateSelection this.showStackFrame(object)", object);
            else
                FBTrace.sysout("script updateSelection this.showStackFrame(null)", object);
        }

        if (object instanceof CompilationUnit)
            this.navigate(object);
        else if (object instanceof SourceLink)
            this.showSourceLink(object);
        else if (typeof(object) == "function")
            this.showFunction(object);
        else if (object instanceof StackFrame)
            this.showStackFrame(object);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Scrolling & Highlighting

    scrollToLine: function(href, lineNo, highlighter)
    {
        this.scriptView.scrollToLine(href, lineNo, highlighter);
    },

    removeExeLineHighlight: function(href, lineNo, highlighter)
    {
        this.scriptView.removeDebugLocation();
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Location List

    getLocationList: function()
    {
        return this.context.getAllCompilationUnits();
    },

    getDefaultLocation: function()
    {
        var compilationUnits = this.getLocationList();
        if (!compilationUnits.length)
            return null;

        return compilationUnits[0];
    },

    getObjectLocation: function(compilationUnit)
    {
        return compilationUnit.getURL();
    },

    updateLocation: function(compilationUnit)
    {
        Trace.sysout("scriptPanel.updateLocation; " + (compilationUnit ? compilationUnit.url :
            "no compilation unit"), compilationUnit);

        this.showSource(compilationUnit);

        Events.dispatch(this.fbListeners, "onUpdateScriptLocation",
            [this, compilationUnit]);
    },

    showSource: function(compilationUnit)
    {
        Trace.sysout("scriptPanel.showSource; " + (compilationUnit ? compilationUnit.url :
            "no compilation unit"), compilationUnit);

        if (!compilationUnit)
            compilationUnit = this.getDefaultLocation();

        // Sources doesn't have to be fetched from the server yet. In such case there
        // are not compilation units and so, no default location. We need to just wait
        // since sources are coming asynchronously (the UI will auto update after
        // newScript event).
        if (!compilationUnit)
            return;

        var self = this;
        function callback(unit, firstLineNumber, lastLineNumber, lines)
        {
            self.scriptView.showSource(lines.join(""));
        }

        compilationUnit.getSourceLines(-1, -1, callback);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Search

    search: function(text, reverse)
    {
        return this.scriptView.search(text, reverse);
    },

    onNavigateToNextDocument: function(scanDoc, reverse)
    {
        return this.navigateToNextDocument(scanDoc, reverse);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // ScriptView Listener

    addBreakpoint: function(bp)
    {
        var url = this.location.href;
        var line = bp.line + 1;

        // Persist the breakpoint on the client side.
        BreakpointStore.addBreakpoint(url, line);
    },

    removeBreakpoint: function(bp)
    {
        var url = this.location.href;
        var line = bp.line + 1;

        var bp = BreakpointStore.findBreakpoint(url, line);
        if (!bp)
        {
            TraceError.sysout("scriptPanel.removeBreakpoint; ERROR doesn't exist!");
            return;
        }

        // Remove the breakpoint from the client side store. Breakpoint store
        // will notify all listeners (all Script panel including this one)
        // about breakpoint removal and so, it can be removed from all contexts
        BreakpointStore.removeBreakpoint(url, line);
    },

    getBreakpoints: function(breakpoints)
    {
        if (!this.location)
            return;

        var url = this.location.href;
        var bps = BreakpointStore.getBreakpoints(url);
        if (!bps || !bps.length)
            return;

        breakpoints.push.apply(breakpoints, bps);
    },

    openBreakpointConditionEditor: function(lineIndex, event)
    {
        Trace.sysout("scriptPanel.openBreakpointConditionEditor; Line: " + lineIndex);

        this.editBreakpointCondition(lineIndex);
        Events.cancelEvent(event);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Conditional Breakpoints

    editBreakpointCondition: function(lineNo)
    {
        var target = this.scriptView.getAnnotationTarget(lineNo);
        if (!target)
            return;

        // Create helper object for remembering the line and URL. It's used when
        // the user right clicks on a line with no breakpoint and picks
        // Edit Breakpoint Condition. This should still work and the breakpoint
        // should be created automatically if the user provide a condition.
        var tempBp = {
            lineNo: lineNo,
            href: this.location.getURL(),
            condition: "",
        }

        // The breakpoint doesn't have to exist.
        var bp = BreakpointStore.findBreakpoint(this.location.getURL(), lineNo + 1);
        var condition = bp ? bp.condition : tempBp.condition;

        // xxxHonza: displaying BP conditions in the Watch panel is not supported yet.
        /*if (condition)
        {
            var watchPanel = this.context.getPanel("watches", true);
            watchPanel.removeWatch(condition);
            watchPanel.rebuild();
        }*/

        // Reference to the edited breakpoint.
        var editor = this.getEditor();
        editor.breakpoint = bp ? bp : tempBp;

        Firebug.Editor.startEditing(target, condition, null, null, this);
    },

    onSetBreakpointCondition: function(bp, value)
    {
        // If the breakpoint doesn't yet exist create it now. This allows to create
        // conditional breakpoints in one step.
        var availableBp = BreakpointStore.findBreakpoint(bp.href, bp.lineNo + 1);
        if (!availableBp)
            BreakpointStore.addBreakpoint(bp.href, bp.lineNo + 1, value);

        BreakpointStore.setBreakpointCondition(bp.href, bp.lineNo + 1, value);
    },

    getEditor: function(target, value)
    {
        if (!this.conditionEditor)
        {
            this.conditionEditor = new BreakpointConditionEditor(this.document);
            this.conditionEditor.callback = this.onSetBreakpointCondition.bind(this);
        }

        return this.conditionEditor;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // BreakpointStore Listener

    onBreakpointAdded: function(bp)
    {
        Trace.sysout("scriptPanel.onBreakpointAdded;", bp);

        var self = this;

        function callback(response, bpClient)
        {
            // The breakpoint is set on the server side even if the script doesn't
            // exist yet i.e. error == 'noScript' so, doesn't count this case as
            // an error.
            if (response.error && response.error != "noScript")
            {
                TraceError.sysout("scriptPanel.onBreakpointAdd; ERROR " + response,
                    {response: response, bpClient: bpClient});
                return;
            }

            // Cache the breakpoint-client object since it has API for removing itself.
            // (removal happens in the Script panel when the user clicks a breakpoint
            // in the breakpoint column).

            //xxxHonza: this must be context dependent. We need a list of Breakpoint
            // instances stored in the context pointing to the right BreakpointClient object.
            // This should be probably done in DebuggerTool
            //bp.params.client = bpClient;

            if (FBTrace.DBG_BP)
                FBTrace.sysout("scriptPanel.onBreakpointAdd; breakpoint added", bpClient);
        }

        // Append the new breakpoint to the panel/context.
        // xxxHonza: append the breakpoint only if the script is loaded in this context?
        // But, what if the script is loaded later?
        this.tool.setBreakpoint(this.context, bp.href, bp.lineNo, callback);

        // Ass breakpoint to the UI.
        // xxxHonza: we should add a disabled breakpoint and wait for async response.
        this.scriptView.addBreakpoint(bp);
    },

    onBreakpointRemoved: function(bp)
    {
        Trace.sysout("scriptPanel.onBreakpointRemoved;", bp);

        function callback(response)
        {
            Trace.sysout("scriptPanel.onBreakpointRemoved; Response from the server:", response);
        }

        // Remove the breakpoint from this panel/context.
        this.tool.removeBreakpoint(this.context, bp.href, bp.lineNo, callback);

        // Remove breakpoint from the UI.
        // xxxHonza: we should mark it as disabled and wait for the response from the server.
        this.scriptView.removeBreakpoint(bp);
    },

    onBreakpointEnabled: function(bp)
    {
        this.tool.enableBreakpoint(this.context, bp.href, bp.lineNo, function()
        {
        });

        // Remove breakpoint from the UI.
        // xxxHonza: should be async
        this.scriptView.updateBreakpoint(bp);
    },

    onBreakpointDisabled: function(bp)
    {
        this.tool.disableBreakpoint(this.context, bp.href, bp.lineNo, function()
        {
        });

        // Remove breakpoint from the UI.
        // xxxHonza: should be async
        this.scriptView.updateBreakpoint(bp);
    },

    onBreakpointModified: function(bp)
    {
        this.scriptView.updateBreakpoint(bp);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Options

    getOptionsMenuItems: function()
    {
        return [
            Menu.optionMenu("firebug.breakpoint.showBreakNotifications",
                "showBreakNotification",
                "firebug.breakpoint.tip.Show_Break_Notifications")
        ];
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Context Menu

    onContextMenu: function(event, items)
    {
        var target = event.target;
        var line = this.scriptView.getLineIndex(target);
        var menuItems = this.getContextMenuItems(line, target);
        items.push.apply(items, menuItems);
    },

    getContextMenuItems: function(lineNo, target)
    {
        var items = [];

        var text = this.scriptView.getSelectedText();
        if (text.toString())
        {
            items.push({
                label: "CopySourceCode",
                tooltiptext: "script.tip.Copy_Source_Code",
                command: Obj.bind(this.copySource, this)
            },
            "-",
            {
                label: "AddWatch",
                tooltiptext: "watch.tip.Add_Watch",
                command: Obj.bind(this.addSelectionWatch, this)
            });
        }

        var hasBreakpoint = BreakpointStore.hasBreakpoint(this.location.href, lineNo + 1);
        items.push("-",
        {
            label: "SetBreakpoint",
            tooltiptext: "script.tip.Set_Breakpoint",
            type: "checkbox",
            checked: hasBreakpoint,
            command: Obj.bindFixed(this.toggleBreakpoint, this, lineNo)
        });

        if (hasBreakpoint)
        {
            var isDisabled = BreakpointStore.isBreakpointDisabled(this.location.href, lineNo);
            items.push({
                label: "breakpoints.Disable_Breakpoint",
                tooltiptext: "breakpoints.tip.Disable_Breakpoint",
                type: "checkbox",
                checked: isDisabled,
                command: Obj.bindFixed(this.toggleDisableBreakpoint, this, lineNo)
            });
        }

        items.push({
            label: "EditBreakpointCondition",
            tooltiptext: "breakpoints.tip.Edit_Breakpoint_Condition",
            command: Obj.bindFixed(this.editBreakpointCondition, this, lineNo)
        });

        if (this.context.stopped)
        {
            var debuggr = this;
            items.push(
                "-",
                // xxxHonza: TODO
                /*{
                    label: "script.Rerun",
                    tooltiptext: "script.tip.Rerun",
                    id: "contextMenuRerun",
                    command: Obj.bindFixed(debuggr.rerun, debuggr, this.context),
                    acceltext: "Shift+F8"
                },*/
                {
                    label: "script.Continue",
                    tooltiptext: "script.tip.Continue",
                    id: "contextMenuContinue",
                    command: Obj.bindFixed(debuggr.resume, debuggr, this.context),
                    acceltext: "F8"
                },
                {
                    label: "script.Step_Over",
                    tooltiptext: "script.tip.Step_Over",
                    id: "contextMenuStepOver",
                    command: Obj.bindFixed(debuggr.stepOver, debuggr, this.context),
                    acceltext: "F10"
                },
                {
                    label: "script.Step_Into",
                    tooltiptext: "script.tip.Step_Into",
                    id: "contextMenuStepInto",
                    command: Obj.bindFixed(debuggr.stepInto, debuggr, this.context),
                    acceltext: "F11"
                },
                {
                    label: "script.Step_Out",
                    tooltiptext: "script.tip.Step_Out",
                    id: "contextMenuStepOut",
                    command: Obj.bindFixed(debuggr.stepOut, debuggr, this.context),
                    acceltext: "Shift+F11"
                }
                //xxxHonza: TODO
                /*{
                    label: "firebug.RunUntil",
                    tooltiptext: "script.tip.Run_Until",
                    id: "contextMenuRunUntil",
                    command: Obj.bindFixed(debuggr.runUntil, debuggr, this.context,
                        compilationUnit, lineNo)
                }*/
            )
        }

        return items;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Context Menu Commands

    copySource: function()
    {
        var text = this.scriptView.getSelectedText();
        System.copyToClipboard(text);
    },

    addSelectionWatch: function()
    {
        var watchPanel = this.context.getPanel("watches", true);
        if (!watchPanel)
            return;

        var text = this.scriptView.getSelectedText();
        watchPanel.addWatch(text);
    },

    toggleBreakpoint: function(line)
    {
        // Convert to breakpoint lines (one based).
        line = line + 1;

        var hasBreakpoint = BreakpointStore.hasBreakpoint(this.location.href, line);
        if (hasBreakpoint)
            BreakpointStore.removeBreakpoint(this.location.href, line);
        else
            BreakpointStore.addBreakpoint(this.location.href, line);
    },

    toggleDisableBreakpoint: function(line)
    {
        // Convert to breakpoit lines (one based).
        line = line + 1;

        var isDisabled = BreakpointStore.isBreakpointDisabled(this.location.href, line);
        if (isDisabled)
            BreakpointStore.enableBreakpoint(this.location.href, line);
        else
            BreakpointStore.disableBreakpoint(this.location.href, line);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // BON

    supportsBreakOnNext: function()
    {
        return this.breakable && Firebug.jsDebuggerOn;
    },

    breakOnNext: function(enabled)
    {
        if (enabled)
            this.tool.breakOnNext(this.context, true);
        else
            this.tool.breakOnNext(this.context, false);
    },

    getBreakOnNextTooltip: function(armed)
    {
        return (armed ?
            Locale.$STR("script.Disable Break On Next") : Locale.$STR("script.Break On Next"));
    },

    shouldBreakOnNext: function()
    {
        return !!this.context.breakOnNextHook;  // TODO BTI
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Toolbar functions

    attachListeners: function(context, chrome)
    {
        this.keyListeners =
        [
            chrome.keyCodeListen("F8", Events.isShift, Obj.bind(this.rerun, this, context), true),
            chrome.keyCodeListen("F8", null, Obj.bind(this.resume, this, context), true),
            chrome.keyCodeListen("F10", null, Obj.bind(this.stepOver, this, context), true),
            chrome.keyCodeListen("F11", null, Obj.bind(this.stepInto, this, context)),
            chrome.keyCodeListen("F11", Events.isShift, Obj.bind(this.stepOut, this, context))
        ];
    },

    detachListeners: function(context, chrome)
    {
        if (this.keyListeners)
        {
            for (var i = 0; i < this.keyListeners.length; ++i)
                chrome.keyIgnore(this.keyListeners[i]);
            delete this.keyListeners;
        }
    },

    syncListeners: function(context)
    {
        var chrome = Firebug.chrome;

        if (context.stopped)
            this.attachListeners(context, chrome);
        else
            this.detachListeners(context, chrome);
    },

    syncCommands: function(context)
    {
        var chrome = Firebug.chrome;
        if (!chrome)
        {
            TraceError.sysout("debugger.syncCommand, context with no chrome: " +
                context.getGlobalScope());

            return;
        }

        if (context.stopped)
        {
            chrome.setGlobalAttribute("fbDebuggerButtons", "stopped", "true");
            chrome.setGlobalAttribute("cmd_firebug_rerun", "disabled", "false");
            chrome.setGlobalAttribute("cmd_firebug_resumeExecution", "disabled", "false");
            chrome.setGlobalAttribute("cmd_firebug_stepOver", "disabled", "false");
            chrome.setGlobalAttribute("cmd_firebug_stepInto", "disabled", "false");
            chrome.setGlobalAttribute("cmd_firebug_stepOut", "disabled", "false");
        }
        else
        {
            chrome.setGlobalAttribute("fbDebuggerButtons", "stopped", "false");
            chrome.setGlobalAttribute("cmd_firebug_rerun", "disabled", "true");
            chrome.setGlobalAttribute("cmd_firebug_stepOver", "disabled", "true");
            chrome.setGlobalAttribute("cmd_firebug_stepInto", "disabled", "true");
            chrome.setGlobalAttribute("cmd_firebug_stepOut", "disabled", "true");
            chrome.setGlobalAttribute("cmd_firebug_resumeExecution", "disabled", "true");
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Toolbar functions

    rerun: function(context)
    {
        this.tool.rerun(context);
    },

    resume: function(context)
    {
        this.tool.resume(context);
    },

    stepOver: function(context)
    {
        this.tool.stepOver(context);
    },

    stepInto: function(context)
    {
        this.tool.stepInto(context);
    },

    stepOut: function(context)
    {
        this.tool.stepOut(context);
    },

    runUntil: function(context, compilationUnit, lineNo)
    {
        this.tool.runUntil(compilationUnit, lineNo);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    supportsObject: function(object, type)
    {
        if (object instanceof CompilationUnit
            || (object instanceof SourceLink && object.type == "js")
            || typeof(object) == "function"
            || object instanceof StackFrame)
        {
            // Higher priority than the DOM panel.
            return 2;
        }

        return 0;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Tool Listener

    onStartDebugging: function(context, event, packet)
    {
        Trace.sysout("scriptPanel.onStartDebugging; " + this.context.getName());

        try
        {
            var currentBreakable = Firebug.chrome.getGlobalAttribute(
                "cmd_firebug_toggleBreakOn", "breakable");

            Trace.sysout("scriptPanel.onStartDebugging; currentBreakable " + currentBreakable +
                " in " + this.context.getName() + " currentContext " +
                Firebug.currentContext.getName());

            // If currentBreakable is false, then we are armed, but we broke
            if (currentBreakable == "false")
                Firebug.chrome.setGlobalAttribute("cmd_firebug_toggleBreakOn", "breakable", "true");

            // If Firebug is minimized, open the UI to show we are stopped
            if (Firebug.isMinimized())
                Firebug.unMinimize();

            this.syncCommands(this.context);
            this.syncListeners(this.context);

            // Update Break on Next lightning
            //Firebug.Breakpoint.updatePanelTab(this, false);

            // This is how the Watch panel is synchronized.
            Firebug.chrome.select(this.context.currentFrame, "script", null, true);
            Firebug.chrome.syncPanel("script");  // issue 3463 and 4213
            Firebug.chrome.focus();
        }
        catch (exc)
        {
            TraceError.sysout("Resuming debugger: error during debugging loop: " + exc, exc);
            Firebug.Console.log("Resuming debugger: error during debugging loop: " + exc);

            this.resume(this.context);
        }
    },

    onStopDebugging: function(context, event, packet)
    {
        Trace.sysout("scriptPanel.onStopDebugging; " + this.context.getName());

        try
        {
            var chrome = Firebug.chrome;

            /*if (this.selectedSourceBox && this.selectedSourceBox.breakCauseBox)
            {
                this.selectedSourceBox.breakCauseBox.hide();
                delete this.selectedSourceBox.breakCauseBox;
            }*/

            this.syncCommands(this.context);
            this.syncListeners(this.context);
            this.showNoStackFrame();

            // After main panel is completely updated
            chrome.syncSidePanels();
        }
        catch (exc)
        {
            TraceError.sysout("scriptPanel.onStopDebugging; EXCEPTION " + exc, exc);
        }
    },

    newScript: function(sourceFile)
    {
        Trace.sysout("scriptPanel.newScript; " + sourceFile.href, sourceFile);

        // New script has been appended, update the default location if necessary.
        if (!this.location)
            this.navigate(null);

        // Initialize existing breakpoints
        //var bps = BreakpointStore.getBreakpoints(sourceFile.href);
        //self.tool.setBreakpoints(self.context, bps, function(response){});
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Info Tips

    updateInfoTip: function()
    {
        var infoTip = this.panelBrowser ? this.panelBrowser.infoTip : null;
        if (infoTip && this.infoTipExpr)
            this.populateInfoTip(infoTip, this.infoTipExpr);
    },

    showInfoTip: function(infoTip, target, x, y, rangeParent, rangeOffset)
    {
        if (Css.hasClass(target, "breakpoint"))
            return this.populateBreakpointInfoTip(infoTip, target);

        // The source script must be within viewConent DIV (Orion).
        var viewContent = Dom.getAncestorByClass(target, "viewContent");
        if (!viewContent)
            return;

        // See http://code.google.com/p/fbug/issues/detail?id=889
        // Idea from: Jonathan Zarate's rikaichan extension (http://www.polarcloud.com/rikaichan/)
        if (!rangeParent)
            return false;

        rangeOffset = rangeOffset || 0;
        var expr = getExpressionAt(rangeParent.data, rangeOffset);
        if (!expr || !expr.expr)
            return false;

        if (expr.expr == this.infoTipExpr)
            return true;
        else
            return this.populateInfoTip(infoTip, expr.expr);
    },

    populateInfoTip: function(infoTip, expr)
    {
        if (!expr || Keywords.isJavaScriptKeyword(expr))
            return false;

        // Tooltips for variables in the script source are only displayed if the
        // script execution is halted (i.e. there is a current frame).
        var frame = this.context.currentFrame;
        if (!frame)
            return false;

        //xxxHonza: expression evaluation is not finished.
        return false;

        var self = this;
        this.tool.eval(this.context, null, expr, function (context, event, packet)
        {
            var result = packet.why.frameFinished["return"];
            self.onPopulateInfoTip(infoTip, result);
        });

        // The result will be fetched asynchronously so, the tooltip should
        // display a throbber or something...
        return true;
    },

    onPopulateInfoTip: function(infoTip, result)
    {
        var gripObj = this.context.gripCache.getObject(result);
        gripObj.getProperties().then(function(props)
        {
            var value = gripObj.getValue();

            var rep = Firebug.getRep(value, context);
            var tag = rep.shortTag ? rep.shortTag : rep.tag;

            tag.replace({object: value}, infoTip);
        });
    },

    populateBreakpointInfoTip: function(infoTip, target)
    {
        var lineNo = this.scriptView.getLineIndex(target);
        var bp = BreakpointStore.findBreakpoint(this.location.href, lineNo + 1);
        var expr = bp.condition;
        if (!expr)
            return false;

        if (expr == this.infoTipExpr)
            return true;

        BreakpointInfoTip.render(infoTip, expr);

        this.infoTipExpr = expr;

        return true;
    },
});

// ********************************************************************************************* //
// Breakpoint InfoTip Template

with (Domplate) {
var BreakpointInfoTip = domplate(Firebug.Rep,
{
    tag:
        DIV("$expr"),

    render: function(parentNode, expr)
    {
        this.tag.replace({expr: expr}, parentNode, this);
    }
})};

// ********************************************************************************************* //

const reWord = /([A-Za-z_$0-9]+)(\.([A-Za-z_$0-9]+)|\[([A-Za-z_$0-9]+|["'].+?["'])\])*/;

function getExpressionAt(text, charOffset)
{
    var offset = 0;
    for (var m = reWord.exec(text); m; m = reWord.exec(text.substr(offset)))
    {
        var word = m[0];
        var wordOffset = offset+m.index;
        if (charOffset >= wordOffset && charOffset <= wordOffset+word.length)
        {
            var innerOffset = charOffset-wordOffset;
            m = word.substr(innerOffset+1).match(/\.|\]|\[|$/);
            var end = m.index + innerOffset + 1, start = 0;

            var openBr = word.lastIndexOf('[', innerOffset);
            var closeBr = word.lastIndexOf(']', innerOffset);

            if (openBr == innerOffset)
                end++;
            else if (closeBr < openBr)
            {
                if (/['"\d]/.test(word[openBr+1]))
                    end++;
                else
                    start = openBr + 1;
            }

            word = word.substring(start, end);

            if (/^\d+$/.test(word) && word[0] != '0')
                word = '';

            return {expr: word, offset: wordOffset-start};
        }
        offset = wordOffset+word.length;
    }

    return {expr: null, offset: -1};
};

// ********************************************************************************************* //
// Registration

Firebug.registerPanel(ScriptPanel);

return ScriptPanel;

// ********************************************************************************************* //
});
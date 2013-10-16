/* -*- Mode: C++; tab-width: 20; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

try {
  if (Cc === undefined) {
    var Cc = Components.classes;
    var Ci = Components.interfaces;
  }
} catch (ex) {}

Components.utils.import("resource://gre/modules/Services.jsm");

var NUM_CYCLES = 5;
var numPageCycles = 1;

var pageFilterRegexp = null;
var useBrowser = true;
var winWidth = 1024;
var winHeight = 768;

var doRenderTest = false;

var pages;
var pageIndex;
var start_time;
var cycle;
var pageCycle;
var report;
var noisy = false;
var timeout = -1;
var delay = 250;
var timeoutEvent = -1;
var running = false;
var forceCC = true;
var reportRSS = true;

var useMozAfterPaint = false;
var gPaintWindow = window;
var gPaintListener = false;
var loadAboutBlank = false;

//when TEST_DOES_OWN_TIMING, we need to store the time from the page as MozAfterPaint can be slower than pageload
var gTime = -1;
var gStartTime = -1;
var gReference = -1;

var content;

var TEST_DOES_OWN_TIMING = 1;

var browserWindow = null;

var recordedName = null;
var pageUrls;

// the io service
var gIOS = null;

// metro immersive environment helper
function isImmersive() {
  if (!Cc["@mozilla.org/windows-metroutils;1"])
    return false;
  let metroUtils = Cc["@mozilla.org/windows-metroutils;1"]
                             .createInstance(Ci.nsIWinMetroUtils);
  if (!metroUtils)
    return false;
  return metroUtils.immersive;
}

function plInit() {
  if (running) {
    return;
  }
  running = true;

  cycle = 0;
  pageCycle = 1;

  // Tracks if we are running in a background tab in the metro browser
  let metroTabbedChromeRun = false;

  setTimeout(function(){
  try {
    var args;
    
    /*
     * Desktop firefox:
     * non-chrome talos runs - tp-cmdline will create and load pageloader
     * into the main window of the app which displays and tests content.
     * chrome talos runs - tp-cmdline does the same however pageloader
     * creates a new chromed browser window below for content.
     *    
     * Immersive firefox:
     * non-chrome talos runs - tp-cmdline will create and load pageloader
     * into the main metro window without browser chrome.
     * chrome talos runs - tp-cmdline loads the browser interface and
     * passes pageloader in as the default uri. Pageloader then adds a new
     * content tab which displays and tests content.
     */

    // In metro chrome runs, the browser window has our cmdline arguments. In
    // every other case they are on window.
    let toplevelwin = Services.wm.getMostRecentWindow("navigator:browser");

    if (isImmersive() && toplevelwin.arguments[0].wrappedJSObject) {
      args = toplevelwin.arguments[0].wrappedJSObject;
      if (!args.useBrowserChrome) {
        // Huh? Should never happen.
        throw new Exception("non-browser chrome test requested but we detected a metro immersive in-tab run?");
      }
      // running in a background tab
      metroTabbedChromeRun = true;
    } else {
      args = window.arguments[0].wrappedJSObject;
    }

    var manifestURI = args.manifest;
    var startIndex = 0;
    var endIndex = -1;
    if (args.startIndex) startIndex = parseInt(args.startIndex);
    if (args.endIndex) endIndex = parseInt(args.endIndex);
    if (args.numCycles) NUM_CYCLES = parseInt(args.numCycles);
    if (args.numPageCycles) numPageCycles = parseInt(args.numPageCycles);
    if (args.width) winWidth = parseInt(args.width);
    if (args.height) winHeight = parseInt(args.height);
    if (args.filter) pageFilterRegexp = new RegExp(args.filter);
    if (args.noisy) noisy = true;
    if (args.timeout) timeout = parseInt(args.timeout);
    if (args.delay) delay = parseInt(args.delay);
    if (args.mozafterpaint) useMozAfterPaint = true;
    if (args.rss) reportRSS = true;
    if (args.loadaboutblank) loadAboutBlank = true;

    forceCC = !args.noForceCC;
    doRenderTest = args.doRender;

    if (forceCC &&
        !window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
               .getInterface(Components.interfaces.nsIDOMWindowUtils)
               .garbageCollect) {
      forceCC = false;
    }

    gIOS = Cc["@mozilla.org/network/io-service;1"]
      .getService(Ci.nsIIOService);
    if (args.offline)
      gIOS.offline = true;
    var fileURI = gIOS.newURI(manifestURI, null, null);
    pages = plLoadURLsFromURI(fileURI);

    if (!pages) {
      dumpLine('tp: could not load URLs, quitting');
      plStop(true);
    }

    if (pages.length == 0) {
      dumpLine('tp: no pages to test, quitting');
      plStop(true);
    }

    if (startIndex < 0)
      startIndex = 0;
    if (endIndex == -1 || endIndex >= pages.length)
      endIndex = pages.length-1;
    if (startIndex > endIndex) {
      dumpLine("tp: error: startIndex >= endIndex");
      plStop(true);
    }

    pages = pages.slice(startIndex,endIndex+1);
    pageUrls = pages.map(function(p) { return p.url.spec.toString(); });
    report = new Report();

    if (doRenderTest)
      renderReport = new Report();

    pageIndex = 0;

    if (metroTabbedChromeRun) {
      // Pageloader script runs from a background tab, create the tab we'll
      // be loading content into and measuring.
      let tab = toplevelwin.Browser.addTab("about:blank", true);

      // Various globals we need to do measurments
      gPaintWindow = tab.browser.contentWindow;
      content = tab.browser;

      if (reportRSS) {
        initializeMemoryCollector(plLoadPage, delay);
      } else {
        setTimeout(plLoadPage, delay);
      }
    } else if (args.useBrowserChrome) {
      // Create a new chromed browser window for content
      var wwatch = Cc["@mozilla.org/embedcomp/window-watcher;1"]
        .getService(Ci.nsIWindowWatcher);
      var blank = Cc["@mozilla.org/supports-string;1"]
        .createInstance(Ci.nsISupportsString);
      blank.data = "about:blank";
      browserWindow = wwatch.openWindow
        (null, "chrome://browser/content/", "_blank",
         "chrome,all,dialog=no,width=" + winWidth + ",height=" + winHeight, blank);

      gPaintWindow = browserWindow;
      // get our window out of the way
      window.resizeTo(10,10);

      var browserLoadFunc = function (ev) {
        browserWindow.removeEventListener('load', browserLoadFunc, true);

        // do this half a second after load, because we need to be
        // able to resize the window and not have it get clobbered
        // by the persisted values
        setTimeout(function () {
                     browserWindow.resizeTo(winWidth, winHeight);
                     browserWindow.moveTo(0, 0);
                     browserWindow.focus();

                     content = browserWindow.getBrowser();

                     // Load the frame script for e10s / IPC message support
                     if (content.getAttribute("remote") == "true") {
                       let contentScript = "data:,function _contentLoadHandler(e) { " +
                         "  if (e.originalTarget.defaultView == content) { " +
                         "    content.wrappedJSObject.tpRecordTime = function(t, s) { sendAsyncMessage('PageLoader:RecordTime', { time: t, startTime: s }); }; ";
                        if (useMozAfterPaint) {
                          contentScript += "" + 
                          "function _contentPaintHandler() { " +
                          "  var utils = content.QueryInterface(Components.interfaces.nsIInterfaceRequestor).getInterface(Components.interfaces.nsIDOMWindowUtils); " +
                          "  if (utils.isMozAfterPaintPending) { " +
                          "    addEventListener('MozAfterPaint', function(e) { " +
                          "      removeEventListener('MozAfterPaint', arguments.callee, true); " + 
                          "      sendAsyncMessage('PageLoader:MozAfterPaint', {}); " +
                          "    }, true); " + 
                          "  } else { " +
                          "    sendAsyncMessage('PageLoader:MozAfterPaint', {}); " +
                          "  } " +
                          "}; " +
                          "content.wrappedJSObject.setTimeout(_contentPaintHandler, 0); ";
                       } else {
                         contentScript += "    sendAsyncMessage('PageLoader:Load', {}); ";
                       }
                       contentScript += "" + 
                         "  }" +
                         "} " +
                         "addEventListener('load', _contentLoadHandler, true); ";
                       content.messageManager.loadFrameScript(contentScript, false);
                     }
                     if (reportRSS) {
                       initializeMemoryCollector(plLoadPage, 100);
                     } else {
                       setTimeout(plLoadPage, 100);
                     }
                   }, 500);
      };

      browserWindow.addEventListener('load', browserLoadFunc, true);
    } else {
      // Loading content into the initial window we create
      gPaintWindow = window;
      window.resizeTo(winWidth, winHeight);

      content = document.getElementById('contentPageloader');

      if (reportRSS) {
        initializeMemoryCollector(plLoadPage, delay);
      } else {
        setTimeout(plLoadPage, delay);
      }
    }
  } catch(e) {
    dumpLine("pageloader exception: " + e);
    plStop(true);
  }

  }, 5000);
}

function plPageFlags() {
  return pages[pageIndex].flags;
}

// load the current page, start timing
var removeLastAddedListener = null;
var removeLastAddedMsgListener = null;
function plLoadPage() {
  var pageName = pages[pageIndex].url.spec;

  if (removeLastAddedListener)
    removeLastAddedListener();

  if (removeLastAddedMsgListener)
    removeLastAddedMsgListener();

  if (plPageFlags() & TEST_DOES_OWN_TIMING) {
    // if the page does its own timing, use a capturing handler
    // to make sure that we can set up the function for content to call

    content.addEventListener('load', plLoadHandlerCapturing, true);
    removeLastAddedListener = function() {
      content.removeEventListener('load', plLoadHandlerCapturing, true);
      if (useMozAfterPaint) {
        content.removeEventListener("MozAfterPaint", plPaintedCapturing, true);
        gPaintListener = false;
      }
    };
  } else {
    // if the page doesn't do its own timing, use a bubbling handler
    // to make sure that we're called after the page's own onload() handling

    // XXX we use a capturing event here too -- load events don't bubble up
    // to the <browser> element.  See bug 390263.
    content.addEventListener('load', plLoadHandler, true);
    removeLastAddedListener = function() {
      content.removeEventListener('load', plLoadHandler, true);
      if (useMozAfterPaint) {
        gPaintWindow.removeEventListener("MozAfterPaint", plPainted, true);
        gPaintListener = false;
      }
    };
  }

  // If the test browser is remote (e10s / IPC) we need to use messages to watch for page load
  if (content.getAttribute("remote") == "true") {
    content.messageManager.addMessageListener('PageLoader:Load', plLoadHandlerMessage);
    content.messageManager.addMessageListener('PageLoader:RecordTime', plRecordTimeMessage);
    if (useMozAfterPaint)
      content.messageManager.addMessageListener('PageLoader:MozAfterPaint', plPaintHandler);
    removeLastAddedMsgListener = function() {
      content.messageManager.removeMessageListener('PageLoader:Load', plLoadHandlerMessage);
      content.messageManager.removeMessageListener('PageLoader:RecordTime', plRecordTimeMessage);
      if (useMozAfterPaint)
        content.messageManager.removeMessageListener('PageLoader:MozAfterPaint', plPaintHandler);
    };
  }

  if (timeout > 0) {
    timeoutEvent = setTimeout('loadFail()', timeout);
  }
  if (reportRSS) {
    collectMemory(startAndLoadURI, pageName);
  } else {
    startAndLoadURI(pageName);
  }
}

function startAndLoadURI(pageName) {
  start_time = Date.now();
  if (loadAboutBlank)
    content.loadURI('about:blank');
  setTimeout(function() {content.loadURI(pageName) }, 0);
}

function loadFail() {
  var pageName = pages[pageIndex].url.spec;
  dumpLine("__FAILTimeout exceeded on " + pageName + "__FAIL")
  plStop(true);
}

function plNextPage() {
  var doNextPage = false;
  if (pageCycle < numPageCycles) {
    pageCycle++;
    doNextPage = true;
  } else if (pageIndex < pages.length-1) {
    pageIndex++;
    recordedName = null;
    pageCycle = 1;
    doNextPage = true;
  }

  if (doNextPage == true) {
    if (forceCC) {
      var tccstart = new Date();
      window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
            .getInterface(Components.interfaces.nsIDOMWindowUtils)
            .garbageCollect();
      var tccend = new Date();
      report.recordCCTime(tccend - tccstart);
    }

    setTimeout(plLoadPage, delay);
  } else {
    plStop(false);
  }
}

function plRecordTime(time) {
  var pageName = pages[pageIndex].url.spec;
  var i = pageIndex
  if (i < pages.length-1) {
    i++;
  } else {
    i = 0;
  }
  var nextName = pages[i].url.spec;
  if (!recordedName) {
    recordedName = pageUrls[pageIndex];
  }
  if (typeof(time) == "string") {
    var times = time.split(',');
    var names = recordedName.split(',');
    for (var t = 0; t < times.length; t++) {
      if (names.length == 1) {
        report.recordTime(names, times[t]);
      } else {
        report.recordTime(names[t], times[t]);
      }
    }
  } else {
    report.recordTime(recordedName, time);
  }
  if (noisy) {
    dumpLine("Cycle " + (cycle+1) + "(" + pageCycle + ")" + ": loaded " + pageName + " (next: " + nextName + ")");
  }
}

function plLoadHandlerCapturing(evt) {
  // make sure we pick up the right load event
  if (evt.type != 'load' ||
       evt.originalTarget.defaultView.frameElement)
      return;

  //set the tpRecordTime function (called from test pages we load to store a global time.
  content.contentWindow.wrappedJSObject.tpRecordTime = function (time, startTime, testName) {
    gTime = time;
    gStartTime = startTime;
    recordedName = testName;
    setTimeout(plWaitForPaintingCapturing, 0);
  }

  content.removeEventListener('load', plLoadHandlerCapturing, true);

  setTimeout(plWaitForPaintingCapturing, 0);
}

function plWaitForPaintingCapturing() {
  if (gPaintListener)
    return;

  var utils = gPaintWindow.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                   .getInterface(Components.interfaces.nsIDOMWindowUtils);

  if (utils.isMozAfterPaintPending && useMozAfterPaint) {
    if (gPaintListener == false)
      gPaintWindow.addEventListener("MozAfterPaint", plPaintedCapturing, true);
    gPaintListener = true;
    return;
  }

  _loadHandlerCapturing();
}

function plPaintedCapturing() {
  gPaintWindow.removeEventListener("MozAfterPaint", plPaintedCapturing, true);
  gPaintListener = false;
  _loadHandlerCapturing();
}

function _loadHandlerCapturing() {
  if (timeout > 0) { 
    clearTimeout(timeoutEvent);
  }

  if (!(plPageFlags() & TEST_DOES_OWN_TIMING)) {
    dumpLine("tp: Capturing onload handler used with page that doesn't do its own timing?");
    plStop(true);
  }

  if (useMozAfterPaint) {
    if (gStartTime != null && gStartTime >= 0) {
      gTime = (new Date()) - gStartTime;
      gStartTime = -1;
    }
  }

  // set up the function for content to call
  if (gTime != -1) {
    plRecordTime(gTime);
    gTime = -1;
    recordedName = null;
    setTimeout(plNextPage, delay);
  };
}

// the onload handler
function plLoadHandler(evt) {
  // make sure we pick up the right load event
  if (evt.type != 'load' ||
       evt.originalTarget.defaultView.frameElement)
      return;

  content.removeEventListener('load', plLoadHandler, true);
  setTimeout(waitForPainted, 0);
}

// This is called after we have received a load event, now we wait for painted
function waitForPainted() {

  var utils = gPaintWindow.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                   .getInterface(Components.interfaces.nsIDOMWindowUtils);

  if (!utils.isMozAfterPaintPending || !useMozAfterPaint) {
    _loadHandler();
    return;
  }

  if (gPaintListener == false)
    gPaintWindow.addEventListener("MozAfterPaint", plPainted, true);
  gPaintListener = true;
}

function plPainted() {
  gPaintWindow.removeEventListener("MozAfterPaint", plPainted, true);
  gPaintListener = false;
  _loadHandler();
}

function _loadHandler() {
  if (timeout > 0) { 
    clearTimeout(timeoutEvent);
  }
  var docElem;
  if (browserWindow)
    docElem = browserWindow.frames["content"].document.documentElement;
  else
    docElem = content.contentDocument.documentElement;
  var width;
  if ("getBoundingClientRect" in docElem) {
    width = docElem.getBoundingClientRect().width;
  } else if ("offsetWidth" in docElem) {
    width = docElem.offsetWidth;
  }

  var end_time = Date.now();
  var time = (end_time - start_time);

  // does this page want to do its own timing?
  // if so, we shouldn't be here
  if (plPageFlags() & TEST_DOES_OWN_TIMING) {
    dumpLine("tp: Bubbling onload handler used with page that does its own timing?");
    plStop(true);
  }

  plRecordTime(time);

  if (doRenderTest)
    runRenderTest();

  plNextPage();
}

// the onload handler used for remote (e10s) browser
function plLoadHandlerMessage(message) {
  _loadHandlerMessage();
}

// the mozafterpaint handler for remote (e10s) browser
function plPaintHandler(message) {
  _loadHandlerMessage();
}

// the core handler for remote (e10s) browser
function _loadHandlerMessage() {
  if (timeout > 0) { 
    clearTimeout(timeoutEvent);
  }

  var time = -1;

  // does this page want to do its own timing?
  if ((plPageFlags() & TEST_DOES_OWN_TIMING)) {
    if (typeof(gStartTime) != "number")
      gStartTime = Date.parse(gStartTime);

    if (gTime >= 0) {
      if (useMozAfterPaint && gStartTime >= 0) {
        gTime = Date.now() - gStartTime;
        gStartTime = -1;
      } else if (useMozAfterPaint) {
        gTime = -1;
      }
      time = gTime;
      gTime = -1;
    }

  } else {
    var end_time = Date.now();
    time = (end_time - start_time);
  }

  if (time >= 0) {
    plRecordTime(time);
    if (doRenderTest)
      runRenderTest();

    plNextPage();
  }
}

// the record time handler used for remote (e10s) browser
function plRecordTimeMessage(message) {
  gTime = message.json.time;
  if (useMozAfterPaint) {
    gStartTime = message.json.startTime;
  }
  _loadHandlerMessage();
}

function runRenderTest() {
  const redrawsPerSample = 500;

  if (!Ci.nsIDOMWindowUtils)
    return;

  var win;

  if (browserWindow)
    win = content.contentWindow;
  else
    win = window;
  var wu = win.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowUtils);

  var start = Date.now();
  for (var j = 0; j < redrawsPerSample; j++)
    wu.redraw();
  var end = Date.now();

  renderReport.recordTime(pageIndex, end - start);
}

function plStop(force) {
  if (reportRSS) {
    collectMemory(plStopAll, force);
  } else {
    plStopAll(force);
  }
}

function plStopAll(force) {
  try {
    if (force == false) {
      pageIndex = 0;
      pageCycle = 1;
      if (cycle < NUM_CYCLES-1) {
        cycle++;
        recordedName = null;
        setTimeout(plLoadPage, delay);
        return;
      }

      /* output report */
      dumpLine(report.getReport());
    }
  } catch (e) {
    dumpLine(e);
  }

  if (reportRSS) {
    stopMemCollector();
  }

  if (content) {
    content.removeEventListener('load', plLoadHandlerCapturing, true);
    content.removeEventListener('load', plLoadHandler, true);
    if (useMozAfterPaint)
      content.removeEventListener("MozAfterPaint", plPaintedCapturing, true);
      content.removeEventListener("MozAfterPaint", plPainted, true);

    if (content.getAttribute("remote") == "true") {
      content.messageManager.removeMessageListener('PageLoader:Load', plLoadHandlerMessage);
      content.messageManager.removeMessageListener('PageLoader:RecordTime', plRecordTimeMessage);
      if (useMozAfterPaint)
        content.messageManager.removeMessageListener('PageLoader:MozAfterPaint', plPaintHandler);

      content.messageManager.loadFrameScript("data:,removeEventListener('load', _contentLoadHandler, true);", false);
    }
  }

  if (MozillaFileLogger)
    MozillaFileLogger.close();

  goQuitApplication();
}

/* Returns array */
function plLoadURLsFromURI(manifestUri) {
  var fstream = Cc["@mozilla.org/network/file-input-stream;1"]
    .createInstance(Ci.nsIFileInputStream);
  var uriFile = manifestUri.QueryInterface(Ci.nsIFileURL);

  fstream.init(uriFile.file, -1, 0, 0);
  var lstream = fstream.QueryInterface(Ci.nsILineInputStream);

  var d = [];

  var lineNo = 0;
  var line = {value:null};
  var more;
  do {
    lineNo++;
    more = lstream.readLine(line);
    var s = line.value;

    // strip comments (only leading ones)
    s = s.replace(/^#.*/, '');

    // strip leading and trailing whitespace
    s = s.replace(/^\s*/, '').replace(/\s*$/, '');

    if (!s)
      continue;

    var flags = 0;
    var urlspec = s;

    // split on whitespace, and figure out if we have any flags
    var items = s.split(/\s+/);
    if (items[0] == "include") {
      if (items.length != 2) {
        dumpLine("tp: Error on line " + lineNo + " in " + manifestUri.spec + ": include must be followed by the manifest to include!");
        return null;
      }

      var subManifest = gIOS.newURI(items[1], null, manifestUri);
      if (subManifest == null) {
        dumpLine("tp: invalid URI on line " + manifestUri.spec + ":" + lineNo + " : '" + line.value + "'");
        return null;
      }

      var subItems = plLoadURLsFromURI(subManifest);
      if (subItems == null)
        return null;
      d = d.concat(subItems);
    } else {
      if (items.length == 2) {
        if (items[0].indexOf("%") != -1)
          flags |= TEST_DOES_OWN_TIMING;

        urlspec = items[1];
      } else if (items.length != 1) {
        dumpLine("tp: Error on line " + lineNo + " in " + manifestUri.spec + ": whitespace must be %-escaped!");
        return null;
      }

      var url = gIOS.newURI(urlspec, null, manifestUri);

      if (pageFilterRegexp && !pageFilterRegexp.test(url.spec))
        continue;

      d.push({   url: url,
               flags: flags });
    }
  } while (more);

  return d;
}

function dumpLine(str) {
  if (MozillaFileLogger)
    MozillaFileLogger.log(str + "\n");
  dump(str);
  dump("\n");
}

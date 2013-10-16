# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""A generic means of running an URL based browser test
   follows the following steps
     - creates a profile
     - tests the profile
     - gets metrics for the current test environment
     - loads the url
     - collects info on any counters while test runs
     - waits for a 'dump' from the browser
"""

import mozinfo
import os
import platform
import results
import traceback
import sys
import subprocess
import tempfile
import time
import utils
import copy
import mozcrash

try:
    import mozdevice
except:
    # mozdevice is known not to import correctly with python 2.4, which we
    # still support
    pass

from utils import talosError, talosCrash, talosRegression
from ffprocess_linux import LinuxProcess
from ffprocess_win32 import Win32Process
from ffprocess_mac import MacProcess
from ffsetup import FFSetup

class TTest(object):

    _ffsetup = None
    _ffprocess = None
    platform_type = ''

    def __init__(self, remote = False):
        cmanager, platformtype, ffprocess = self.getPlatformType(remote)
        self.CounterManager = cmanager
        self.platform_type = platformtype
        self._ffprocess = ffprocess
        self._hostproc = ffprocess
        self.remote = remote

        self._ffsetup = FFSetup(self._ffprocess)

    def getPlatformType(self, remote):

        _ffprocess = None
        if remote == True:
            platform_type = 'remote_'
            import cmanager
            CounterManager = cmanager.CounterManager
        elif platform.system() == "Linux":
            import cmanager_linux
            CounterManager = cmanager_linux.LinuxCounterManager
            platform_type = 'linux_'
            _ffprocess = LinuxProcess()
        elif platform.system() in ("Windows", "Microsoft"):
            if '5.1' in platform.version(): #winxp
                platform_type = 'win_'
            elif '6.1' in platform.version(): #w7
                platform_type = 'w7_'
            elif '6.2' in platform.version(): #w8
                platform_type = 'w8_'
            else:
                raise talosError('unsupported windows version')
            import cmanager_win32
            CounterManager = cmanager_win32.WinCounterManager
            _ffprocess = Win32Process()
        elif platform.system() == "Darwin":
            import cmanager_mac
            CounterManager = cmanager_mac.MacCounterManager
            platform_type = 'mac_'
            _ffprocess = MacProcess()
        return CounterManager, platform_type, _ffprocess

    def initializeLibraries(self, browser_config):
        if browser_config['remote'] == True:
            cmanager, platform_type, ffprocess = self.getPlatformType(False)

            from ffprocess_remote import RemoteProcess
            self._ffprocess = RemoteProcess(browser_config['host'],
                                            browser_config['port'],
                                            browser_config['deviceroot'])
            self._ffsetup = FFSetup(self._ffprocess)
            self._ffsetup.initializeRemoteDevice(browser_config, ffprocess)
            self._hostproc = ffprocess

    def createProfile(self, profile_path, preferences, extensions, webserver):
        # Create the new profile
        temp_dir, profile_dir = self._ffsetup.CreateTempProfileDir(profile_path,
                                                     preferences,
                                                     extensions,
                                                     webserver)
        utils.debug("created profile")
        return profile_dir, temp_dir

    def initializeProfile(self, profile_dir, browser_config):
        if not self._ffsetup.InitializeNewProfile(profile_dir, browser_config):
            raise talosError("failed to initialize browser")
        processes = self._ffprocess.checkAllProcesses(browser_config['process'], browser_config['child_process'])
        if processes:
            raise talosError("browser failed to close after being initialized")

    def cleanupProfile(self, dir):
        # Delete the temp profile directory  Make it writeable first,
        # because every once in a while browser seems to drop a read-only
        # file into it.
        self._hostproc.removeDirectory(dir)

    def cleanupAndCheckForCrashes(self, browser_config, profile_dir, test_name):
        """cleanup browser processes and process crashes if found"""

        # cleanup processes
        self._ffprocess.cleanupProcesses(browser_config['process'],
                                         browser_config['child_process'],
                                         browser_config['browser_wait'])

        # find stackwalk binary
        if platform.system() in ('Windows', 'Microsoft'):
            stackwalkpaths = ['win32', 'minidump_stackwalk.exe']
        elif platform.system() == 'Linux':
            # are we 64 bit?
            if '64' in platform.architecture()[0]:
                stackwalkpaths = ['linux64', 'minidump_stackwalk']
            else:
                stackwalkpaths = ['linux', 'minidump_stackwalk']
        elif platform.system() == 'Darwin':
            stackwalkpaths = ['osx', 'minidump_stackwalk']
        else:
            # no minidump_stackwalk available for your platform
            return
        stackwalkbin = os.path.join(os.path.dirname(__file__), 'breakpad', *stackwalkpaths)
        assert os.path.exists(stackwalkbin), "minidump_stackwalk binary not found: %s" % stackwalkbin

        if browser_config['remote'] is True:
            # favour using Java exceptions in the logcat over minidumps
            if os.path.exists('logcat.log'):
                with open('logcat.log') as f:
                    logcat = f.read().split('\r')
                found = mozcrash.check_for_java_exception(logcat)

            if not found:
                # check for minidumps
                minidumpdir = tempfile.mkdtemp()
                try:
                    remoteminidumpdir = profile_dir + '/minidumps/'
                    if self._ffprocess.testAgent.dirExists(remoteminidumpdir):
                        self._ffprocess.testAgent.getDirectory(remoteminidumpdir, minidumpdir)
                except mozdevice.DMError:
                    print "Remote Device Error: Error getting crash minidumps from device"
                    raise
                found = mozcrash.check_for_crashes(minidumpdir,
                                                   browser_config['symbols_path'],
                                                   stackwalk_binary=stackwalkbin,
                                                   test_name=test_name)

            # cleanup dumps on remote
            self._ffprocess.testAgent.removeDir(remoteminidumpdir)
            self._hostproc.removeDirectory(minidumpdir)
        else:
            # check for minidumps
            minidumpdir = os.path.join(profile_dir, 'minidumps')
            found = mozcrash.check_for_crashes(minidumpdir,
                                               browser_config['symbols_path'],
                                               stackwalk_binary=stackwalkbin,
                                               test_name=test_name)

        if found:
            raise talosCrash("Found crashes after test run, terminating test")

    def setupRobocopTests(self, browser_config, profile_dir):
        try:
            deviceRoot = self._ffprocess.testAgent.getDeviceRoot()
            fHandle = open("robotium.config", "w")
            fHandle.write("profile=%s\n" % profile_dir)

            remoteLog = deviceRoot + "/" + browser_config['browser_log']
            fHandle.write("logfile=%s\n" % remoteLog)
            fHandle.write("host=http://%s\n" % browser_config['webserver'])
            fHandle.write("rawhost=http://%s\n" % browser_config['webserver'])
            envstr = ""
            delim = ""
            # This is not foolproof and the ideal solution would be to have one env/line instead of a single string
            for key, value in browser_config.get('env', {}).items():
                try:
                    value.index(',')
                    print "Error: Found an ',' in our value, unable to process value."
                except ValueError:
                    envstr += "%s%s=%s" % (delim, key, value)
                    delim = ","

            fHandle.write("envvars=%s\n" % envstr)
            fHandle.close()

            self._ffprocess.testAgent.removeFile(os.path.join(deviceRoot, "fennec_ids.txt"))
            self._ffprocess.testAgent.removeFile(os.path.join(deviceRoot, "robotium.config"))
            self._ffprocess.testAgent.removeFile(remoteLog)
            self._ffprocess.testAgent.pushFile("robotium.config", os.path.join(deviceRoot, "robotium.config"))
            self._ffprocess.testAgent.pushFile(browser_config['fennecIDs'], os.path.join(deviceRoot, "fennec_ids.txt"))
        except mozdevice.DMError:
            print "Remote Device Error: Error copying files for robocop setup"
            raise


    def testCleanup(self, browser_config, profile_dir, test_config, cm, temp_dir):
        try:
            if cm:
                cm.stopMonitor()

            if os.path.isfile(browser_config['browser_log']):
                results_file = open(browser_config['browser_log'], "r")
                results_raw = results_file.read()
                results_file.close()
                utils.info(results_raw)

            if profile_dir:
                try:
                    self.cleanupAndCheckForCrashes(browser_config, profile_dir, test_config['name'])
                except talosError:
                    # ignore this error since we have already checked for crashes earlier
                    pass

            if temp_dir:
                self.cleanupProfile(temp_dir)
        except talosError, te:
            utils.debug("cleanup error: %s", te.msg)
        except Exception:
            utils.debug("unknown error during cleanup: %s" % (traceback.format_exc(),))

    def runTest(self, browser_config, test_config):
        """
            Runs an url based test on the browser as specified in the browser_config dictionary

        Args:
            browser_config:  Dictionary of configuration options for the browser (paths, prefs, etc)
            test_config   :  Dictionary of configuration for the given test (url, cycles, counters, etc)

        """
        self.initializeLibraries(browser_config)

        utils.debug("operating with platform_type : %s", self.platform_type)
        counters = test_config.get(self.platform_type + 'counters', [])
        resolution = test_config['resolution']
        utils.setEnvironmentVars(browser_config['env'])
        utils.setEnvironmentVars({'MOZ_CRASHREPORTER_NO_REPORT': '1'})

        if browser_config['symbols_path']:
            utils.setEnvironmentVars({'MOZ_CRASHREPORTER': '1'})
        else:
            utils.setEnvironmentVars({'MOZ_CRASHREPORTER_DISABLE': '1'})

        utils.setEnvironmentVars({"LD_LIBRARY_PATH" : os.path.dirname(browser_config['browser_path'])})

        profile_dir = None
        temp_dir = None

        try:
            running_processes = self._ffprocess.checkAllProcesses(browser_config['process'], browser_config['child_process'])
            if running_processes:
                msg = " already running before testing started (unclean system)"
                utils.debug("%s%s", browser_config['process'], msg)
                running_processes_str = ", ".join([('[%s] %s' % (pid, process_name)) for pid, process_name in running_processes])
                raise talosError("Found processes still running: %s. Please close them before running talos." % running_processes_str)

            # add any provided directories to the installed browser
            for dir in browser_config['dirs']:
                self._ffsetup.InstallInBrowser(browser_config['browser_path'],
                                            browser_config['dirs'][dir])

            # make profile path work cross-platform
            test_config['profile_path'] = os.path.normpath(test_config['profile_path'])

            preferences = copy.deepcopy(browser_config['preferences'])
            if 'preferences' in test_config and test_config['preferences']:
                testPrefs = dict([(i, utils.parsePref(j)) for i, j in test_config['preferences'].items()])
                preferences.update(testPrefs)

            extensions = copy.deepcopy(browser_config['extensions'])
            if 'extensions' in test_config and test_config['extensions']:
                extensions.append(test_config['extensions'])

            profile_dir, temp_dir = self.createProfile(test_config['profile_path'], 
                                                       preferences, 
                                                       extensions, 
                                                       browser_config['webserver'])
            self.initializeProfile(profile_dir, browser_config)

            if browser_config['fennecIDs']:
                # This pushes environment variables to the device, be careful of placement
                self.setupRobocopTests(browser_config, profile_dir)

            utils.debug("initialized %s", browser_config['process'])

            # setup global (cross-cycle) counters:
            # shutdown, responsiveness
            global_counters = {}
            if browser_config.get('xperf_path'):
                for c in test_config.get('xperf_counters', []):
                    global_counters[c] = []

            if test_config['shutdown']:
                global_counters['shutdown'] = []
            if test_config.get('responsiveness') and platform.system() != "Linux":
                # ignore responsiveness tests on linux until we fix Bug 710296
               utils.setEnvironmentVars({'MOZ_INSTRUMENT_EVENT_LOOP': '1'})
               utils.setEnvironmentVars({'MOZ_INSTRUMENT_EVENT_LOOP_THRESHOLD': '20'})
               utils.setEnvironmentVars({'MOZ_INSTRUMENT_EVENT_LOOP_INTERVAL': '10'})
               global_counters['responsiveness'] = []

            # instantiate an object to hold test results
            test_results = results.TestResults(test_config, global_counters, extensions=self._ffsetup.extensions)

            for i in range(test_config['cycles']):

                # remove the browser log file
                if os.path.isfile(browser_config['browser_log']):
                    os.chmod(browser_config['browser_log'], 0777)
                    os.remove(browser_config['browser_log'])

                # remove the error file if it exists
                if os.path.exists(browser_config['error_filename']):
                    os.chmod(browser_config['error_filename'], 0777)
                    os.remove(browser_config['error_filename'])

                # on remote devices we do not have the fast launch/shutdown as we do on desktop
                if not browser_config['remote']:
                    time.sleep(browser_config['browser_wait']) #wait out the browser closing

                # check to see if the previous cycle is still hanging around
                if (i > 0) and self._ffprocess.checkAllProcesses(browser_config['process'], browser_config['child_process']):
                    raise talosError("previous cycle still running")

                # Run the test
                timeout = test_config.get('timeout', 7200) # 2 hours default
                total_time = 0
                url = test_config['url']
                command_line = self._ffprocess.GenerateBrowserCommandLine(browser_config['browser_path'],
                                                                        browser_config['extra_args'],
                                                                        browser_config['deviceroot'],
                                                                        profile_dir,
                                                                        url)

                utils.debug("command line: %s", command_line)

                b_log = browser_config['browser_log']
                if self.remote == True:
                    b_log = browser_config['deviceroot'] + '/' + browser_config['browser_log']
                    self._ffprocess.removeFile(b_log)
                    # bug 816719, remove sessionstore.js so we don't interfere with talos
                    self._ffprocess.testAgent.removeFile(os.path.join(self._ffprocess.testAgent.getDeviceRoot(), "profile/sessionstore.js"))

                b_cmd = self._ffprocess.GenerateBControllerCommandLine(command_line, browser_config, test_config)
                try:
                    process = subprocess.Popen(b_cmd, universal_newlines=True, bufsize=0, env=os.environ)
                except:
                    raise talosError("error executing browser command line '%s': %s" % (subprocess.list2cmdline(b_cmd), sys.exc_info()[0]))

                #give browser a chance to open
                # this could mean that we are losing the first couple of data points
                # as the tests starts, but if we don't provide
                # some time for the browser to start we have trouble connecting the CounterManager to it
                # on remote devices we do not have the fast launch/shutdown as we do on desktop
                if not browser_config['remote']:
                    time.sleep(browser_config['browser_wait'])

                #set up the counters for this test
                counter_results = None
                if counters:
                    cm = self.CounterManager(self._ffprocess, browser_config['process'], counters)
                    counter_results = dict([(counter, []) for counter in counters])

                #the main test loop, monitors counters and checks for browser output
                dumpResult = ""
                while total_time < timeout:
                    # Sleep for [resolution] seconds
                    time.sleep(resolution)
                    total_time += resolution
                    fileData = self._ffprocess.getFile(b_log)
                    if fileData and len(fileData) > 0:
                        newResults = fileData.replace(dumpResult, '')
                        if len(newResults.strip()) > 0:
                            utils.info(newResults)
                            dumpResult = fileData

                    # Get the output from all the possible counters
                    for count_type in counters:
                        val = cm.getCounterValue(count_type)
                        if val:
                            counter_results[count_type].append(val)
                    if process.poll() != None: #browser_controller completed, file now full
                        break

                if hasattr(process, 'kill'):
                    # BBB python 2.4 does not have Popen.kill(); see
                    # https://bugzilla.mozilla.org/show_bug.cgi?id=752951#c6
                    try:
                        process.kill()
                    except OSError, e:
                        if (not mozinfo.isWin) and (e.errno != 3):
                            # 3 == No such process in Linux and Mac (errno.h)
                            raise

                if total_time >= timeout:
                    raise talosError("timeout exceeded")

                #stop the counter manager since this test is complete
                if counters:
                    cm.stopMonitor()

                # ensure the browser log exists
                browser_log_filename = browser_config['browser_log']
                if not os.path.isfile(browser_log_filename):
                    raise talosError("no output from browser [%s]" % browser_log_filename)

                # ensure the browser log exists
                if os.path.exists(browser_config['error_filename']):
                    raise talosRegression("Talos has found a regression, if you have questions ask for help in irc on #perf")

                # add the results from the browser output
                test_results.add(browser_log_filename, counter_results=counter_results)

                # on remote devices we do not have the fast launch/shutdown as we do on desktop
                if not browser_config['remote']:
                    time.sleep(browser_config['browser_wait'])

                #clean up any stray browser processes
                self.cleanupAndCheckForCrashes(browser_config, profile_dir, test_config['name'])
                #clean up the bcontroller process
                timer = 0
                while ((process.poll() is None) and timer < browser_config['browser_wait']):
                    time.sleep(1)
                    timer+=1

            # cleanup
            self.cleanupProfile(temp_dir)
            utils.restoreEnvironmentVars()

            # include global (cross-cycle) counters
            test_results.all_counter_results.extend([{key: value} for key, value in global_counters.items()])

            # return results
            return test_results

        except Exception, e:
            counters = vars().get('cm', counters)
            self.testCleanup(browser_config, profile_dir, test_config, counters, temp_dir)
            raise


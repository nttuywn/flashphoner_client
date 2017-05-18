'use strict';

var adapter = require('webrtc-adapter');
var uuid = require('node-uuid');
var util = require('./util');
var connections = {};
var CACHED_INSTANCE_POSTFIX = "-CACHED_WEBRTC_INSTANCE";
var extensionId;
var defaultConstraints;
var logger;
var LOG_PREFIX = "webrtc";
var audioContext;

var createConnection = function (options) {
    return new Promise(function (resolve, reject) {
        var id = options.id;
        var connectionConfig = options.connectionConfig || {"iceServers": []};
        var connectionConstraints = options.connectionConstraints || {};
        if (!connectionConstraints.hasOwnProperty("optional")) {
            connectionConstraints.optional = [{"DtlsSrtpKeyAgreement": true}];
        }
        var connection = new RTCPeerConnection(connectionConfig, connectionConstraints);
        //unidirectional display
        var display = options.display;
        //bidirectional local
        var localDisplay = options.localDisplay;
        //bidirectional remote
        var remoteDisplay = options.remoteDisplay;
        var bidirectional = options.bidirectional;
        var localVideo;
        var remoteVideo;
        //mixer
        var mixedStream;
        var gainNode;
        if (bidirectional) {
            localVideo = getCacheInstance(localDisplay);
            remoteVideo = document.createElement('video');
            localVideo.id = id + "-local";
            remoteVideo.id = id + "-remote";
            remoteDisplay.appendChild(remoteVideo);
            connection.addStream(localVideo.srcObject);
        } else {
            localVideo = getCacheInstance(display);
            if (localVideo) {
                localVideo.id = id;
                connection.addStream(localVideo.srcObject);
            } else {
                remoteVideo = document.createElement('video');
                remoteVideo.id = id;
                display.appendChild(remoteVideo);
            }
        }

        connection.ontrack = function (event) {
            if (remoteVideo) {
                remoteVideo.srcObject = event.streams[0];
                remoteVideo.onloadedmetadata = function (e) {
                    if (remoteVideo) {
                        remoteVideo.play();
                    }
                };
            }
        };
        connection.onremovestream = function (event) {
            if (remoteVideo) {
                remoteVideo.pause();
            }
        };
        connection.onsignalingstatechange = function (event) {
            if (connection.signalingState == "closed" && mixedStream) {
                console.log("Close audio context");
                stopMix();
            }
        };
        connection.oniceconnectionstatechange = function (event) {
        };
        var state = function () {
            return connection.signalingState;
        };
        var close = function (cacheCamera) {
            if (remoteVideo) {
                removeVideoElement(remoteVideo);
                remoteVideo = null;
            }
            if (localVideo && !getCacheInstance((localDisplay || display)) && cacheCamera) {
                localVideo.id = localVideo.id + CACHED_INSTANCE_POSTFIX;
                unmuteAudio();
                unmuteVideo();
                localVideo = null;
            } else if (localVideo) {
                removeVideoElement(localVideo);
                localVideo = null;
            }
            if (connection.signalingState !== "closed") {
                connection.close();
            }
            delete connections[id];
        };
        var createOffer = function (options) {
            return new Promise(function (resolve, reject) {
                var hasAudio = true;
                var hasVideo = true;
                if (localVideo) {
                    if (!localVideo.srcObject.getAudioTracks()[0]) {
                        hasAudio = false;
                    }
                    if (!localVideo.srcObject.getVideoTracks()[0]) {
                        hasVideo = false;
                        options.receiveVideo = false;
                    }
                }
                var constraints = {
                    offerToReceiveAudio: options.receiveAudio,
                    offerToReceiveVideo: options.receiveVideo
                };
                //create offer and set local sdp
                connection.createOffer(constraints).then(function (offer) {
                    connection.setLocalDescription(offer).then(function () {
                        var o = {};
                        o.sdp = util.stripCodecs(offer.sdp, options.stripCodecs);
                        o.hasAudio = hasAudio;
                        o.hasVideo = hasVideo;
                        resolve(o);
                    });
                });
            });
        };
        var createAnswer = function (options) {
            return new Promise(function (resolve, reject) {
                //create offer and set local sdp
                connection.createAnswer().then(function (answer) {
                    connection.setLocalDescription(answer).then(function () {
                        resolve(util.stripCodecs(answer.sdp, options.stripCodecs));
                    });
                });
            });
        };
        var changeAudioCodec = function (codec) {
            return false;
        };
        var setRemoteSdp = function (sdp) {
            logger.debug(LOG_PREFIX, "setRemoteSDP:");
            logger.debug(LOG_PREFIX, sdp);
            return new Promise(function (resolve, reject) {
                var sdpType;
                if (connection.signalingState == 'have-local-offer') {
                    sdpType = 'answer';
                } else {
                    sdpType = 'offer';
                }
                var rtcSdp = new RTCSessionDescription({
                    type: sdpType,
                    sdp: sdp
                });
                connection.setRemoteDescription(rtcSdp).then(function () {
                    //use in edge for ice
                    //var sdpArray = sdp.split("\n");
                    //var video = false;
                    //for (var i = 0; i < sdpArray.length; i++) {
                    //    if (sdpArray[i].indexOf("m=video") == 0) {
                    //        video = true;
                    //    }
                    //    if (sdpArray[i].indexOf("a=candidate") == 0) {
                    //        if (video) {
                    //            var candidate = new RTCIceCandidate({
                    //                candidate: sdpArray[i],
                    //                sdpMid: "video",
                    //                sdpMLineIndex: 1
                    //            });
                    //            connection.addIceCandidate(candidate);
                    //        } else {
                    //            var candidate = new RTCIceCandidate({
                    //                candidate: sdpArray[i],
                    //                sdpMid: "audio",
                    //                sdpMLineIndex: 0
                    //            });
                    //            connection.addIceCandidate(candidate);
                    //        }
                    //    }
                    //}
                    resolve();
                }).catch(function (error) {
                    reject(error);
                });
            });
        };

        var getVolume = function () {
            if (remoteVideo && remoteVideo.srcObject && remoteVideo.srcObject.getAudioTracks().length > 0) {
                //return remoteVideo.srcObject.getAudioTracks()[0].volume * 100;
                return remoteVideo.volume * 100;
            }
            return -1;
        };
        var setVolume = function (volume) {
            if (remoteVideo && remoteVideo.srcObject && remoteVideo.srcObject.getAudioTracks().length > 0) {
                remoteVideo.volume = volume / 100;
            }
        };
        var muteAudio = function () {
            if (localVideo && localVideo.srcObject && localVideo.srcObject.getAudioTracks().length > 0) {
                localVideo.srcObject.getAudioTracks()[0].enabled = false;
            }
        };
        var unmuteAudio = function () {
            if (localVideo && localVideo.srcObject && localVideo.srcObject.getAudioTracks().length > 0) {
                localVideo.srcObject.getAudioTracks()[0].enabled = true;
            }
        };
        var isAudioMuted = function () {
            if (localVideo && localVideo.srcObject && localVideo.srcObject.getAudioTracks().length > 0) {
                return !localVideo.srcObject.getAudioTracks()[0].enabled;
            }
            return true;
        };
        var muteVideo = function () {
            if (localVideo && localVideo.srcObject && localVideo.srcObject.getVideoTracks().length > 0) {
                localVideo.srcObject.getVideoTracks()[0].enabled = false;
            }
        };
        var unmuteVideo = function () {
            if (localVideo && localVideo.srcObject && localVideo.srcObject.getVideoTracks().length > 0) {
                localVideo.srcObject.getVideoTracks()[0].enabled = true;
            }
        };
        var isVideoMuted = function () {
            if (localVideo && localVideo.srcObject && localVideo.srcObject.getVideoTracks().length > 0) {
                return !localVideo.srcObject.getVideoTracks()[0].enabled;
            }
            return true;
        };
        var getStats = function (callbackFn) {
            if (connection) {
                if (adapter.browserDetails.browser == "chrome") {
                    connection.getStats(null).then(function (rawStats) {
                        var results = rawStats;
                        var result = {type: "chrome", outgoingStreams: {}, incomingStreams: {}};
                        if (rawStats instanceof Map) {
                            rawStats.forEach(function (v, k, m) {
                                handleResult(v);
                            });
                        } else {
                            for (var i = 0; i < results.length; ++i) {
                                handleResult(results[i]);
                            }
                        }
                        function handleResult(res) {
                            var resultPart = util.processRtcStatsReport(adapter.browserDetails.browser, res);
                            if (resultPart != null) {
                                if (resultPart.type == "googCandidatePair") {
                                    result.activeCandidate = resultPart;
                                } else if (resultPart.type == "ssrc") {
                                    if (resultPart.transportId.indexOf("audio") > -1) {
                                        if (resultPart.id.indexOf("send") > -1) {
                                            result.outgoingStreams.audio = resultPart;
                                        } else {
                                            result.incomingStreams.audio = resultPart;
                                        }

                                    } else {
                                        if (resultPart.id.indexOf("send") > -1) {
                                            result.outgoingStreams.video = resultPart;
                                        } else {
                                            result.incomingStreams.video = resultPart;
                                        }

                                    }
                                }
                            }
                        }

                        callbackFn(result);
                    }).catch(function (error) {
                        callbackFn(error)
                    });
                } else if (adapter.browserDetails.browser == "firefox") {
                    connection.getStats(null).then(function (rawStats) {
                        var result = {type: "firefox", outgoingStreams: {}, incomingStreams: {}};
                        for (var k in rawStats) {
                            if (rawStats.hasOwnProperty(k)) {
                                var resultPart = util.processRtcStatsReport(adapter.browserDetails.browser, rawStats[k]);
                                if (resultPart != null) {
                                    if (resultPart.type == "outboundrtp") {
                                        if (resultPart.id.indexOf("audio") > -1) {
                                            result.outgoingStreams.audio = resultPart;
                                        } else {
                                            result.outgoingStreams.video = resultPart;
                                        }
                                    } else if (resultPart.type == "inboundrtp") {
                                        if (resultPart.id.indexOf("audio") > -1) {
                                            result.incomingStreams.audio = resultPart;
                                        } else {
                                            result.incomingStreams.video = resultPart;
                                        }
                                    }
                                }
                            }
                        }
                        callbackFn(result);
                    }).catch(function (error) {
                        callbackFn(error)
                    });
                }
            }
        };

        var exports = {};
        exports.state = state;
        exports.createOffer = createOffer;
        exports.createAnswer = createAnswer;
        exports.setRemoteSdp = setRemoteSdp;
        exports.changeAudioCodec = changeAudioCodec;
        exports.close = close;
        exports.setVolume = setVolume;
        exports.getVolume = getVolume;
        exports.muteAudio = muteAudio;
        exports.unmuteAudio = unmuteAudio;
        exports.isAudioMuted = isAudioMuted;
        exports.muteVideo = muteVideo;
        exports.unmuteVideo = unmuteVideo;
        exports.isVideoMuted = isVideoMuted;
        exports.getStats = getStats;
        connections[id] = exports;
        resolve(exports);
    });
};

var getMediaAccess = function (constraints, display) {
    return new Promise(function (resolve, reject) {
        if (!constraints) {
            constraints = defaultConstraints;
            if (getCacheInstance(display)) {
                resolve(display);
                return;
            }
        } else {
            constraints = normalizeConstraints(constraints);
            releaseMedia(display);
        }
        //check if this is screen sharing
        if (constraints.video && constraints.video.type && constraints.video.type == "screen") {
            delete constraints.video.type;
            getScreenDeviceId(constraints).then(function (screenSharingConstraints) {
                //copy constraints
                for (var prop in screenSharingConstraints) {
                    if (screenSharingConstraints.hasOwnProperty(prop)) {
                        constraints.video[prop] = screenSharingConstraints[prop];
                    }
                }
                if (adapter.browserDetails.browser == "chrome") {
                    delete constraints.video.frameRate;
                    delete constraints.video.height;
                    delete constraints.video.width;
                }
                getAccess(constraints, true);
            }, reject);
        } else {
            getAccess(constraints);
        }

        function getAccess(constraints, screenShare) {
            logger.info(LOG_PREFIX, constraints);
            var requestMicStream = false;
            if (screenShare) {
                if (constraints.audio && adapter.browserDetails.browser == "chrome") {
                    requestMicStream = true;
                    delete constraints.audio;
                }
            }
            navigator.getUserMedia(constraints, function (stream) {
                var video = document.createElement('video');
                display.appendChild(video);
                video.id = uuid.v1() + CACHED_INSTANCE_POSTFIX;
                //show local camera
                video.srcObject = stream;
                //mute audio
                video.muted = true;
                video.onloadedmetadata = function (e) {
                    video.play();
                };
                // This hack for chrome only, firefox supports screen-sharing + audio natively
                if (requestMicStream && adapter.browserDetails.browser == "chrome") {
                    logger.info(LOG_PREFIX, "Request for audio stream");
                    navigator.getUserMedia({audio: true}, function (stream) {
                        logger.info(LOG_PREFIX, "Got audio stream, add it to video stream");
                        video.srcObject.addTrack(stream.getAudioTracks()[0]);
                        resolve(display);
                    });
                } else {
                    resolve(display);
                }
            }, reject);
        }
    });
};

var getScreenDeviceId = function (constraints) {
    return new Promise(function (resolve, reject) {
        var o = {};
        if (window.chrome) {
            chrome.runtime.sendMessage(extensionId, {type: "isInstalled"}, function (response) {
                if (response) {
                    o.maxWidth = constraints.video.width;
                    o.maxHeight = constraints.video.height;
                    o.maxFrameRate = constraints.video.frameRate.max;
                    o.chromeMediaSource = "desktop";
                    chrome.runtime.sendMessage(extensionId, {type: "getSourceId"}, function (response) {
                        if (response.error) {
                            reject(new Error("Screen access denied"));
                        } else {
                            o.chromeMediaSourceId = response.sourceId;
                            resolve({mandatory: o});
                        }
                    });
                } else {
                    reject(new Error("Screen sharing extension is not available"));
                }
            });
        } else {
            //firefox case
            o.mediaSource = "window";
            o.width = {
                min: constraints.video.width,
                max: constraints.video.width
            };
            o.height = {
                min: constraints.video.height,
                max: constraints.video.height
            };
            o.frameRate = {
                min: constraints.video.frameRate.max,
                max: constraints.video.frameRate.max
            };
            resolve(o);
        }
    });
};

var releaseMedia = function (display) {
    var video = getCacheInstance(display);
    if (video) {
        removeVideoElement(video);
        return true;
    }
    return false;
};

function getCacheInstance(display) {
    var i;
    for (i = 0; i < display.children.length; i++) {
        if (display.children[i] && display.children[i].id.indexOf(CACHED_INSTANCE_POSTFIX) != -1) {
            logger.info(LOG_PREFIX, "FOUND WEBRTC CACHED INSTANCE, id " + display.children[i].id);
            return display.children[i];
        }
    }
}

function removeVideoElement(video) {
    if (video.srcObject) {
        //pause
        video.pause();
        //stop media tracks
        var tracks = video.srcObject.getTracks();
        for (var i = 0; i < tracks.length; i++) {
            tracks[i].stop();
        }
    }
    if (video.parentNode) {
        video.parentNode.removeChild(video);
    }
}
/**
 * Check WebRTC available
 *
 * @returns {boolean} webrtc available
 */
var available = function () {
    return (adapter.browserDetails.browser != "edge") ? navigator.getUserMedia && RTCPeerConnection : false;
    //return navigator.getUserMedia && RTCPeerConnection;
};

var listDevices = function (labels) {
    return new Promise(function (resolve, reject) {
        var list = {
            audio: [],
            video: []
        };
        if (labels) {
            var display = document.createElement("div");
            getMediaAccess({audio: true, video: {}}, display).then(function () {
                populateList(display);
            }, reject);
        } else {
            populateList();
        }

        function populateList(display) {
            navigator.mediaDevices.enumerateDevices().then(function (devices) {
                for (var i = 0; i < devices.length; i++) {
                    var device = devices[i];
                    var ret = {
                        id: device.deviceId,
                        label: device.label
                    };
                    if (device.kind == "audioinput") {
                        ret.type = "mic";
                        list.audio.push(ret);
                    } else if (device.kind == "videoinput") {
                        ret.type = "camera";
                        list.video.push(ret);
                    } else {
                        logger.info(LOG_PREFIX, "unknown device " + device.kind + " id " + device.deviceId);
                    }
                }
                if (display) {
                    releaseMedia(display);
                }
                resolve(list);
            }, reject);
        }
    });
};

function normalizeConstraints(constraints) {
    if (constraints.video) {
        if (constraints.video.hasOwnProperty('frameRate') && typeof constraints.video.frameRate !== 'object') {
            // Set default FPS value
            var frameRate = (constraints.video.frameRate == 0) ? 30 : constraints.video.frameRate;
            constraints.video.frameRate = {
                min: frameRate,
                max: frameRate
            }
        }
        if (constraints.video.hasOwnProperty('width')) {
            var width = constraints.video.width;
            if (isNaN(width) || width == 0) {
                logger.warn(LOG_PREFIX, "Width or height property has zero/NaN value, set default resolution 320x240");
                constraints.video.width = 320;
                constraints.video.height = 240;
            }
        }
        if (constraints.video.hasOwnProperty('height')) {
            var height = constraints.video.height;
            if (isNaN(height) || height == 0) {
                logger.warn(LOG_PREFIX, "Width or height property has zero/NaN value, set default resolution 320x240");
                constraints.video.width = 320;
                constraints.video.height = 240;
            }
        }
    }
    if (constraints.audio) {
        // The WebRTC AEC implementation doesn't work well on stereophonic sound and makes mono on output
        if (constraints.audio.stereo) {
            constraints.audio.echoCancellation = false;
            constraints.audio.googEchoCancellation = false
        }
    }
    return constraints;
}

// TODO implement
var playFirstSound = function () {
    return true;
};

module.exports = {
    createConnection: createConnection,
    getMediaAccess: getMediaAccess,
    releaseMedia: releaseMedia,
    listDevices: listDevices,
    playFirstSound: playFirstSound,
    available: available,
    configure: function (configuration) {
        extensionId = configuration.extensionId;
        defaultConstraints = configuration.constraints;
        audioContext = configuration.audioContext;
        logger = configuration.logger;
        logger.info(LOG_PREFIX, "Initialized");
    }
};
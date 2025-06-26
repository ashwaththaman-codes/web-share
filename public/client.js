const socket = io({
  transports: ['websocket'],
  upgrade: false,
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000
});
let peerConnection;
let room = "";
let isJoined = false;
let hasCursorAccess = false;
let cleanupCursorControl = null; // Store cleanup function
const video = document.getElementById("video");
const fakeCursor = document.getElementById("fakeCursor");
const roomInput = document.getElementById("room");
const hostButton = document.querySelector('button[onclick="startHost()"]');
const clientButton = document.querySelector('button[onclick="startClient()"]');
const cursorButton = document.getElementById("requestCursor");
const fullScreenButton = document.getElementById("fullScreen");

function updateUI(state, message) {
  console.log(`UI Update: ${state} - ${message}`);
  statusDiv.textContent = message;
  roomInput.disabled = state === "connected";
  hostButton.disabled = state === "connected";
  clientButton.disabled = state === "connected";
  cursorButton.disabled = state !== "connected" || hasCursorAccess;
  fullScreenButton.disabled = state !== "connected" || !video.srcObject;
  if (state === "error" || state === "disconnected") {
    video.style.display = "none";
    fakeCursor.style.display = "none";
  }
}

function toggleFullScreen() {
  if (!video.srcObject) return;
  if (!document.fullscreenElement) {
    video.requestFullscreen().catch(err => {
      console.error("Full-screen error:", err);
      updateUI("error", "Failed to enter full-screen mode: " + err.message);
    });
  } else {
    document.exitFullscreen();
  }
}

function createPeerConnection(isHost) {
  const config = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      {
        urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443"],
        username: "openrelayproject",
        credential: "openrelayproject"
      }
    ]
  };
  peerConnection = new RTCPeerConnection(config);
  
  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      console.log(`${isHost ? "Host" : "Client"} sending ICE candidate:`, JSON.stringify(event.candidate, null, 2));
      socket.emit("signal", { room, data: { candidate: event.candidate } });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log(`${isHost ? "Host" : "Client"} WebRTC state:`, peerConnection.connectionState);
    if (peerConnection.connectionState === "failed") {
      updateUI("error", `${isHost ? "Host" : "Client"} connection failed. Please try again.`);
      peerConnection.close();
      peerConnection = null;
    } else if (peerConnection.connectionState === "connected") {
      console.log(`${isHost ? "Host" : "Client"} successfully connected`);
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log(`${isHost ? "Host" : "Client"} ICE state:`, peerConnection.iceConnectionState);
    if (peerConnection.iceConnectionState === "failed") {
      peerConnection.restartIce();
      console.log(`${isHost ? "Host" : "Client"} restarting ICE`);
    }
  };

  return peerConnection;
}

function requestCursorAccess() {
  if (!room || !isJoined) return;
  console.log("Client requesting cursor access for room:", room);
  socket.emit("cursor-request", { room });
  updateUI("connected", "Waiting for host to approve cursor access...");
  cursorButton.disabled = true;
}

function setupCursorControl() {
  if (cleanupCursorControl) cleanupCursorControl(); // Clean up existing listeners
  let lastMove = 0;
  const moveListener = e => {
    if (!hasCursorAccess || Date.now() - lastMove < 50) return;
    lastMove = Date.now();
    const bounds = video.getBoundingClientRect();
    const x = ((e.clientX - bounds.left) / bounds.width).toFixed(3);
    const y = ((e.clientY - bounds.top) / bounds.height).toFixed(3);
    console.log(`Client sending mouseMove: x=${x}, y=${y}`);
    socket.emit("mouseMove", { room, x, y });
  };

  const clickListener = () => {
    if (!hasCursorAccess) return;
    console.log("Client sending mouseClick");
    socket.emit("mouseClick", { room, button: "left" });
  };

  video.addEventListener("mousemove", moveListener);
  video.addEventListener("click", clickListener);

  return () => {
    video.removeEventListener("mousemove", moveListener);
    video.removeEventListener("click", clickListener);
  };
}

function startHost() {
  room = roomInput.value.trim();
  if (!room) return alert("Please enter a room code");
  updateUI("connected", "Starting session...");

  if (!navigator.mediaDevices || !window.RTCPeerConnection) {
    updateUI("error", "Your browser does not support WebRTC.");
    return;
  }

  navigator.mediaDevices.getDisplayMedia({ video: true })
    .then(stream => {
      video.srcObject = stream;
      video.style.display = "block";
      updateUI("connected", "Hosting session in room: " + room);
      fullScreenButton.disabled = false;

      stream.getVideoTracks()[0].onended = () => {
        console.log("Screen sharing stopped");
        video.srcObject = null;
        video.style.display = "none";
        fakeCursor.style.display = "none";
        peerConnection?.close();
        updateUI("disconnected", "Session ended. Enter a room code to start or join again.");
        socket.emit("leave", room);
        isJoined = false;
        fullScreenButton.disabled = true;
      };

      peerConnection = createPeerConnection(true);
      stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

      socket.on("signal", async ({ data }) => {
        try {
          console.log("Host received signal:", JSON.stringify(data, null, 2));
          if (data.answer) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            console.log("Host set remote description (answer)");
          } else if (data.candidate) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(err => {
              console.error("Host ICE candidate error:", err);
            });
          }
        } catch (err) {
          console.error("Host signaling error:", err);
          updateUI("error", "Host connection error: " + err.message);
        }
      });

      socket.on("no-host", () => {
        console.log("No host in room:", room);
        updateUI("error", "No host found in room: " + room);
      });

      socket.on("user-disconnected", () => {
        console.log("Client disconnected");
        video.srcObject = null;
        video.style.display = "none";
        fakeCursor.style.display = "none";
        updateUI("disconnected", "Client disconnected. Waiting for new clients.");
        fullScreenButton.disabled = true;
      });

      socket.on("cursor-request", ({ clientId }) => {
        console.log(`Cursor access request from client ${clientId}`);
        const approve = confirm(`Client ${clientId} requests cursor access. Approve?`);
        socket.emit("cursor-response", { room, clientId, approved: approve });
      });

      peerConnection.createOffer()
        .then(offer => {
          console.log("Host created offer:", JSON.stringify(offer, null, 2));
          return peerConnection.setLocalDescription(offer);
        })
        .then(() => {
          console.log("Host sending offer");
          socket.emit("signal", { room, data: { offer: peerConnection.localDescription } });
        })
        .catch(err => {
          console.error("Host offer creation error:", err);
          updateUI("error", "Failed to create offer: " + err.message);
        });

      let lastMove = 0;
      socket.on("mouseMove", ({ x, y }) => {
        if (Date.now() - lastMove < 50) return;
        lastMove = Date.now();
        const bounds = video.getBoundingClientRect();
        fakeCursor.style.left = bounds.left + x * bounds.width + "px";
        fakeCursor.style.top = bounds.top + y * bounds.height + "px";
        fakeCursor.style.display = "block";
      });

      socket.on("mouseClick", ({ button }) => {
        console.log("Mouse click:", button);
      });

      if (!isJoined) {
        socket.emit("join", { room, isHost: true });
        isJoined = true;
      }
    })
    .catch(err => {
      console.error("Screen sharing error:", err);
      updateUI("error", "Error sharing screen: " + err.message);
    });
}

function startClient(maxRetries = 3) {
  room = roomInput.value.trim();
  if (!room) return alert("Please enter a room code");
  updateUI("connected", "Connecting to session...");

  if (!window.RTCPeerConnection) {
    updateUI("error", "Your browser does not support WebRTC.");
    return;
  }

  let retries = 0;

  function tryConnect() {
    console.log(`Client connection attempt ${retries + 1}/${maxRetries}`);
    peerConnection = createPeerConnection(false);

    peerConnection.ontrack = event => {
      console.log("Client received stream:", event.streams[0]);
      video.srcObject = event.streams[0];
      video.style.display = "block";
      video.onloadedmetadata = () => {
        updateUI("connected", "Connected to session in room: " + room);
        fullScreenButton.disabled = false;
        if (hasCursorAccess) {
          cleanupCursorControl = setupCursorControl(); // Re-attach listeners if approved
        }
      };
    };

    socket.on("signal", async ({ data }) => {
      try {
        console.log("Client received signal:", JSON.stringify(data, null, 2));
        if (data.offer) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
          console.log("Client set remote description (offer)");
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          console.log("Client sending answer:", JSON.stringify(peerConnection.localDescription, null, 2));
          socket.emit("signal", { room, data: { answer: peerConnection.localDescription } });
        } else if (data.candidate) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(err => {
            console.error("Client ICE candidate error:", err);
          });
        }
      } catch (err) {
        console.error("Client signaling error:", err);
        updateUI("error", "Connection error: " + err.message);
      }
    });

    socket.on("no-host", () => {
      console.log("No host in room:", room);
      updateUI("error", "No host found in room: " + room);
      if (retries < maxRetries) {
        retries++;
        console.log(`Retrying connection (attempt ${retries}/${maxRetries})`);
        setTimeout(tryConnect, 2000);
      } else {
        updateUI("error", "No host found after retries. Please try again.");
      }
    });

    socket.on("user-disconnected", () => {
      console.log("Host disconnected");
      video.srcObject = null;
      video.style.display = "none";
      if (cleanupCursorControl) cleanupCursorControl();
      hasCursorAccess = false;
      updateUI("disconnected", "Host disconnected. Enter a room code to join another session.");
      isJoined = false;
      cursorButton.disabled = true;
      fullScreenButton.disabled = true;
    });

    socket.on("cursor-response", ({ approved }) => {
      console.log(`Cursor access response: ${approved ? "Approved" : "Denied"}`);
      if (approved) {
        hasCursorAccess = true;
        cleanupCursorControl = setupCursorControl();
        updateUI("connected", "Cursor access granted!");
        cursorButton.disabled = true;
      } else {
        hasCursorAccess = false;
        updateUI("connected", "Cursor access denied. Try again?");
        cursorButton.disabled = false;
      }
    });

    if (!isJoined) {
      socket.emit("join", { room, isHost: false });
      isJoined = true;
    }

    setTimeout(() => {
      if (peerConnection?.connectionState !== "connected") {
        console.log("Connection timeout after 30 seconds");
        updateUI("error", "Connection timed out. Please try again.");
        peerConnection?.close();
        peerConnection = null;
        isJoined = false;
        hasCursorAccess = false;
        cursorButton.disabled = true;
        fullScreenButton.disabled = true;
        if (cleanupCursorControl) cleanupCursorControl();
        if (retries < maxRetries) {
          retries++;
          console.log(`Retrying connection (attempt ${retries}/${maxRetries})`);
          setTimeout(tryConnect, 2000);
        }
      }
    }, 30000);
  }

  if (socket.connected) {
    tryConnect();
  } else {
    socket.on("connect", () => {
      console.log("Socket.IO connected, starting client join");
      tryConnect();
    });
  }
}

socket.on("connect", () => {
  console.log("Socket.IO connected");
});

socket.on("connect_error", err => {
  console.error("Socket.IO connect error:", err.message);
  updateUI("error", "Failed to connect to the server: " + err.message);
});

socket.on("reconnect_attempt", attempt => {
  console.log("Socket.IO reconnect attempt:", attempt);
});

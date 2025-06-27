const socket = io({
  transports: ['websocket'],
  upgrade: false,
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000
});
let room = "";
let isJoined = false;
let hasCursorAccess = false;
let cleanupCursorControl = null;
let peerConnection = null;
const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d");
const cursorContainer = document.getElementById("cursorContainer");
const roomInput = document.getElementById("room");
const hostButton = document.querySelector('button[onclick="startHost()"]');
const clientButton = document.querySelector('button[onclick="startClient()"]');
const cursorButton = document.getElementById("requestCursor");
const fullScreenButton = document.getElementById("fullScreen");
const statusDiv = document.getElementById("status");
const cursorRequestsDiv = document.getElementById("cursorRequests");
const requestListDiv = document.getElementById("requestList");

function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

function updateUI(state, message) {
  console.log(`UI Update: ${state} - ${message}`);
  statusDiv.textContent = message;
  roomInput.disabled = state === "connected";
  hostButton.disabled = state === "connected";
  clientButton.disabled = state === "connected";
  cursorButton.disabled = state !== "connected" || hasCursorAccess;
  fullScreenButton.disabled = state !== "connected" || !canvas.style.display.includes("block");
  cursorRequestsDiv.style.display = state === "connected" && roomInput.value ? "block" : "none";
  if (state === "error" || state === "disconnected") {
    canvas.style.display = "none";
    cursorContainer.innerHTML = "";
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
  }
}

function toggleFullScreen() {
  if (canvas.style.display === "none") return;
  if (!document.fullscreenElement) {
    canvas.requestFullscreen().catch(err => {
      console.error("Full-screen error:", err);
      updateUI("error", "Failed to enter full-screen: " + err.message);
    });
  } else {
    document.exitFullscreen();
  }
}

function requestCursorAccess() {
  if (!room || !isJoined) return;
  console.log("Client requesting cursor access for room:", room);
  socket.emit("cursor-request", { room });
  updateUI("connected", "Waiting for host to approve cursor access...");
  cursorButton.disabled = true;
}

function setupCursorControl() {
  if (cleanupCursorControl) cleanupCursorControl();
  let lastMove = 0;
  const moveListener = e => {
    if (!hasCursorAccess || Date.now() - lastMove < 50) return;
    lastMove = Date.now();
    const bounds = canvas.getBoundingClientRect();
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

  canvas.addEventListener("mousemove", moveListener);
  canvas.addEventListener("click", clickListener);

  cleanupCursorControl = () => {
    canvas.removeEventListener("mousemove", moveListener);
    canvas.removeEventListener("click", clickListener);
  };
}

function startHost() {
  room = roomInput.value.trim();
  if (!room) return alert("Please enter a room code");
  updateUI("connected", "Starting session...");

  navigator.mediaDevices.getDisplayMedia({ video: true })
    .then(stream => {
      console.log("Host started screen sharing");
      peerConnection = new RTCPeerConnection();
      stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
      const video = document.createElement("video");
      video.srcObject = stream;
      video.onloadedmetadata = () => {
        video.play();
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.style.display = "block";
        function drawFrame() {
          if (canvas.style.display === "none") return;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          requestAnimationFrame(drawFrame);
        }
        drawFrame();
        updateUI("connected", "Hosting session in room: " + room);
        fullScreenButton.disabled = false;
      };
      video.onerror = () => {
        console.error("Host video stream error");
        updateUI("error", "Failed to render host screen");
      };

      peerConnection.createOffer()
        .then(offer => peerConnection.setLocalDescription(offer))
        .then(() => {
          console.log("Host sending offer");
          socket.emit("offer", { room, offer: peerConnection.localDescription });
        })
        .catch(err => {
          console.error("Host offer error:", err);
          updateUI("error", "Failed to create offer: " + err.message);
        });

      peerConnection.onicecandidate = event => {
        if (event.candidate) {
          console.log("Host sending ICE candidate");
          socket.emit("ice-candidate", { room, candidate: event.candidate });
        }
      };

      socket.on("answer", ({ answer }) => {
        console.log("Host received answer");
        peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
          .catch(err => console.error("Host setRemoteDescription error:", err));
      });

      socket.on("ice-candidate", ({ candidate }) => {
        console.log("Host received ICE candidate");
        peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
          .catch(err => console.error("Host addIceCandidate error:", err));
      });

      socket.emit("start-host", { room });
      isJoined = true;

      const clientCursors = new Map();

      socket.on("cursor-request", ({ clientId }) => {
        console.log(`Cursor access request from client ${clientId}`);
        const requestDiv = document.createElement("div");
        requestDiv.innerHTML = `Client ${clientId} requests cursor access: 
          <button onclick="approveCursor('${clientId}', true)">Approve</button>
          <button onclick="approveCursor('${clientId}', false)">Deny</button>`;
        requestListDiv.appendChild(requestDiv);
        cursorRequestsDiv.style.display = "block";
      });

      window.approveCursor = (clientId, approved) => {
        console.log(`Host approving cursor for ${clientId}: ${approved}`);
        socket.emit("cursor-response", { room, clientId, approved });
        const requests = requestListDiv.children;
        for (let i = 0; i < requests.length; i++) {
          if (requests[i].textContent.includes(clientId)) {
            requests[i].remove();
            break;
          }
        }
        if (requestListDiv.children.length === 0) {
          cursorRequestsDiv.style.display = "none";
        }
      };

      socket.on("mouseMove", ({ clientId, x, y }) => {
        let cursor = clientCursors.get(clientId);
        if (!cursor) {
          cursor = document.createElement("div");
          cursor.className = "fakeCursor";
          cursor.style.backgroundColor = getRandomColor();
          cursorContainer.appendChild(cursor);
          clientCursors.set(clientId, cursor);
        }
        const bounds = canvas.getBoundingClientRect();
        cursor.style.left = bounds.left + x * bounds.width + "px";
        cursor.style.top = bounds.top + y * bounds.height + "px";
        cursor.style.display = "block";
        console.log(`Host received mouseMove from ${clientId}: x=${x}, y=${y}`);
      });

      socket.on("mouseClick", ({ clientId, button }) => {
        console.log(`Host received mouseClick from ${clientId}: ${button}`);
      });

      socket.on("host-stopped", () => {
        console.log("Host session stopped");
        canvas.style.display = "none";
        cursorContainer.innerHTML = "";
        updateUI("disconnected", "Session ended. Enter a room code to start or join again.");
        socket.emit("leave", room);
        isJoined = false;
        fullScreenButton.disabled = true;
        cursorRequestsDiv.style.display = "none";
        stream.getTracks().forEach(track => track.stop());
        if (peerConnection) {
          peerConnection.close();
          peerConnection = null;
        }
      });

      socket.on("user-disconnected", (clientId) => {
        console.log(`Client disconnected: ${clientId}`);
        if (clientCursors.has(clientId)) {
          clientCursors.get(clientId).remove();
          clientCursors.delete(clientId);
        }
        const requests = requestListDiv.children;
        for (let i = 0; i < requests.length; i++) {
          if (requests[i].textContent.includes(clientId)) {
            requests[i].remove();
            break;
          }
        }
        if (requestListDiv.children.length === 0) {
          cursorRequestsDiv.style.display = "none";
        }
      });

      stream.getVideoTracks()[0].onended = () => {
        console.log("Host screen sharing stopped");
        socket.emit("leave", room);
        if (peerConnection) {
          peerConnection.close();
          peerConnection = null;
        }
      };
    })
    .catch(err => {
      console.error("Host screen sharing error:", err);
      updateUI("error", "Failed to start screen sharing: " + err.message);
    });
}

function startClient(maxRetries = 3) {
  room = roomInput.value.trim();
  if (!room) return alert("Please enter a room code");
  updateUI("connected", "Connecting to session...");

  let retries = 0;

  function tryConnect() {
    console.log(`Client connection attempt ${retries + 1}/${maxRetries}`);
    peerConnection = new RTCPeerConnection();
    const video = document.createElement("video");
    video.srcObject = new MediaStream();

    peerConnection.ontrack = event => {
      console.log("Client received stream track");
      video.srcObject.addTrack(event.track);
      video.onloadedmetadata = () => {
        video.play();
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.style.display = "block";
        function drawFrame() {
          if (canvas.style.display === "none") return;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          requestAnimationFrame(drawFrame);
        }
        drawFrame();
        updateUI("connected", "Connected to session in room: " + room);
        fullScreenButton.disabled = false;
        cursorButton.disabled = hasCursorAccess;
        if (hasCursorAccess) {
          setupCursorControl();
        }
      };
      video.onerror = () => {
        console.error("Client video stream error");
        updateUI("error", "Failed to render host screen");
      };
    };

    peerConnection.onicecandidate = event => {
      if (event.candidate) {
        console.log("Client sending ICE candidate");
        socket.emit("ice-candidate", { room, candidate: event.candidate });
      }
    };

    socket.on("offer", ({ offer }) => {
      console.log("Client received offer");
      peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
        .then(() => peerConnection.createAnswer())
        .then(answer => peerConnection.setLocalDescription(answer))
        .then(() => {
          console.log("Client sending answer");
          socket.emit("answer", { room, answer: peerConnection.localDescription });
        })
        .catch(err => {
          console.error("Client offer/answer error:", err);
          updateUI("error", "Failed to process offer: " + err.message);
        });
    });

    socket.on("ice-candidate", ({ candidate }) => {
      console.log("Client received ICE candidate");
      peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
        .catch(err => console.error("Client addIceCandidate error:", err));
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

    socket.on("host-stopped", () => {
      console.log("Host disconnected");
      canvas.style.display = "none";
      if (cleanupCursorControl) cleanupCursorControl();
      hasCursorAccess = false;
      updateUI("disconnected", "Host disconnected. Enter a room code to join another session.");
      isJoined = false;
      cursorButton.disabled = true;
      fullScreenButton.disabled = true;
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
    });

    socket.on("cursor-response", ({ approved }) => {
      console.log(`Cursor access response: ${approved ? "Approved" : "Denied"}`);
      if (approved) {
        hasCursorAccess = true;
        setupCursorControl();
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
      if (!isJoined) {
        console.log("Connection timeout after 30 seconds");
        updateUI("error", "Connection timed out. Please try again.");
        isJoined = false;
        hasCursorAccess = false;
        cursorButton.disabled = true;
        fullScreenButton.disabled = true;
        if (cleanupCursorControl) cleanupCursorControl();
        if (peerConnection) {
          peerConnection.close();
          peerConnection = null;
        }
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

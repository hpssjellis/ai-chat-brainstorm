const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const myApp = express();
const myServer = http.createServer(myApp);
const myIo = new Server(myServer);

// Global App State
let myAdminId = null;
let myApiKey = null;
let mySessionPassword = null;
let myTopic = "Waiting for Admin to set topic...";
let myMessagePool = [];
let myIsProcessing = false;

myApp.get('/', (req, res) => {
  res.send(myGenerateHTML());
});

myIo.on('connection', (mySocket) => {
  mySocket.emit('myUpdateTopic', myTopic);

  mySocket.on('myAdminLogin', (myData) => {
    // Initial Setup
    if (!mySessionPassword && myData.password && myData.key) {
      myApiKey = myData.key;
      mySessionPassword = myData.password;
      myTopic = myData.topic || "General Brainstorm";
      myAdminId = mySocket.id;
      myIo.emit('myUpdateTopic', myTopic);
      mySocket.emit('myAdminAuthSuccess', true);
      mySocket.emit('myPoolUpdate', myMessagePool.length);
    } 
    // Re-authentication
    else if (mySessionPassword && myData.password === mySessionPassword) {
      myAdminId = mySocket.id;
      mySocket.emit('myAdminAuthSuccess', true);
      mySocket.emit('myPoolUpdate', myMessagePool.length);
    }
  });

  mySocket.on('myUserChat', (myMsg) => {
    if (!myMsg.trim()) return;
    myMessagePool.push(myMsg);
    myIo.emit('myChatLogged', myMsg);
    if (myAdminId) {
      myIo.to(myAdminId).emit('myAdminPreview', myMsg);
      myIo.to(myAdminId).emit('myPoolUpdate', myMessagePool.length);
    }
  });

  mySocket.on('myTriggerSummary', async () => {
    if (mySocket.id !== myAdminId || myIsProcessing) return;
    await myHandleAISummary(false);
  });

  mySocket.on('myTriggerTLDR', async () => {
    if (mySocket.id !== myAdminId || myIsProcessing) return;
    await myHandleAISummary(true);
  });
});

async function myHandleAISummary(isTLDR) {
  myIsProcessing = true;
  myIo.emit('myAiStatus', "Gemini is synthesizing...");

  try {
    const myGenAI = new GoogleGenerativeAI(myApiKey);
    const myModel = myGenAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const myInstruction = isTLDR 
      ? "Provide a 1-sentence TL;DR of the ideas so far."
      : `Summarize these brainstorm ideas into a professional list for the topic: ${myTopic}`;

    const myFullInput = `${myInstruction}\n\nUSER MESSAGES:\n${myMessagePool.join('\n')}`;

    const myResult = await myModel.generateContent(myFullInput);
    const myText = myResult.response.text();
    
    const myWaitSeconds = Math.max(5, Math.ceil((myText.split(' ').length / 200) * 60));

    if (isTLDR) {
      myIo.to(myAdminId).emit('myPrivateTLDR', myText);
    } else {
      myMessagePool = []; 
      myIo.emit('myPoolUpdate', 0);
      myIo.emit('myBroadcastSummary', { text: myText, wait: myWaitSeconds });
    }
  } catch (err) {
    myIo.to(myAdminId).emit('myAiStatus', "AI Error: " + err.message);
  }
  myIsProcessing = false;
  myIo.emit('myAiStatus', "");
}

function myGenerateHTML() {
  return `
  <!DOCTYPE html>
  <html>
  <head><title>AI Brainstorm Hub</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="font-family:sans-serif; margin:0; padding:20px; background:#f0f2f5;">
    <div style="max-width:900px; margin:auto; background:white; padding:20px; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
      
      <h2 id="myTopicDisplay" style="text-align:center; color:#1a73e8; margin-top:0;">Loading...</h2>

      <div id="myAuthPanel" style="background:#fff3e0; padding:20px; border-radius:8px; margin-bottom:20px; border:1px solid #ffe0b2;">
        <h4 style="margin-top:0; color:#e65100;">Admin Setup / Re-Login</h4>
        <div style="margin-bottom:15px; font-size:0.9em;">
          Step 1: Get your key here: <a href="https://aistudio.google.com/" target="_blank" style="font-weight:bold; color:#1a73e8;">Google AI Studio</a>
        </div>
        <input id="myPassInput" type="password" placeholder="Session Password" style="padding:10px; margin:5px; border:1px solid #ccc; border-radius:4px;">
        <input id="myApiKeyInput" type="password" placeholder="API Key (Initial Only)" style="padding:10px; margin:5px; width:220px; border:1px solid #ccc; border-radius:4px;">
        <input id="myTopicInput" type="text" placeholder="Topic (Initial Only)" style="padding:10px; margin:5px; border:1px solid #ccc; border-radius:4px;">
        <button onclick="myLogin()" style="padding:10px 20px; background:#e65100; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">Initialize Session</button>
      </div>

      <div id="myAdminDashboard" style="display:none; background:#e8f0fe; padding:20px; border-radius:8px; margin-bottom:20px; border:1px solid #d2e3fc;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h4 style="margin:0;">Admin Dashboard</h4>
          <span id="myPoolCount" style="background:#1a73e8; color:white; padding:4px 10px; border-radius:20px; font-size:0.8em;">Pending Ideas: 0</span>
        </div>
        <div style="margin-top:15px;">
          <button onclick="myGetSummary()" style="background:#1a73e8; color:white; border:none; padding:12px 18px; border-radius:4px; cursor:pointer; font-weight:bold;">Broadcast Summary to Everyone</button>
          <button onclick="myGetTLDR()" style="background:#5f6368; color:white; border:none; padding:12px 18px; border-radius:4px; cursor:pointer; margin-left:10px;">Private TL;DR</button>
        </div>
        <div style="margin-top:15px; font-size:0.85em;">
          <b>Admin Preview (Incoming Feed):</b>
          <div id="myAdminFeed" style="height:80px; overflow-y:auto; background:white; padding:8px; border:1px solid #c2d7f9; margin-top:5px; border-radius:4px;"></div>
        </div>
      </div>

      <div id="myChatBox" style="height:350px; overflow-y:auto; border:1px solid #ddd; padding:15px; background:#fafafa; border-radius:8px; display:flex; flex-direction:column; gap:10px;"></div>
      
      <div id="myAiStatus" style="height:25px; color:#1a73e8; font-style:italic; margin:10px 0; font-weight:bold;"></div>

      <div id="myInputArea" style="display:flex; gap:10px;">
        <input id="myMsg" type="text" style="flex-grow:1; padding:12px; border:1px solid #ccc; border-radius:5px;" placeholder="Type an idea..." onkeypress="if(event.key==='Enter') mySend()">
        <button id="mySendBtn" onclick="mySend()" style="padding:12px 25px; background:#34a853; color:white; border:none; border-radius:5px; cursor:pointer; font-weight:bold;">Send</button>
      </div>

      <div id="myTimer" style="text-align:center; color:#d93025; font-weight:bold; margin-top:15px;"></div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
      const mySocket = io();

      function myLogin() {
        mySocket.emit('myAdminLogin', {
          password: document.getElementById('myPassInput').value,
          key: document.getElementById('myApiKeyInput').value,
          topic: document.getElementById('myTopicInput').value
        });
      }

      mySocket.on('myAdminAuthSuccess', (val) => {
        document.getElementById('myAuthPanel').style.display = 'none';
        document.getElementById('myAdminDashboard').style.display = 'block';
      });

      mySocket.on('myUpdateTopic', (t) => { document.getElementById('myTopicDisplay').innerText = "Topic: " + t; });
      mySocket.on('myAiStatus', (s) => { document.getElementById('myAiStatus').innerText = s; });
      mySocket.on('myPoolUpdate', (count) => { document.getElementById('myPoolCount').innerText = "Pending Ideas: " + count; });

      mySocket.on('myChatLogged', (m) => {
        const myDiv = document.getElementById('myChatBox');
        myDiv.innerHTML += '<div style="background:white; padding:10px 14px; border-radius:15px; align-self:flex-start; box-shadow:0 1px 3px rgba(0,0,0,0.1); max-width:85%; border-bottom-left-radius:2px;">' + m + '</div>';
        myDiv.scrollTop = myDiv.scrollHeight;
      });

      mySocket.on('myAdminPreview', (m) => {
        const myFeed = document.getElementById('myAdminFeed');
        myFeed.innerHTML += '<div style="border-bottom:1px solid #eee; padding:2px 0;">• ' + m + '</div>';
        myFeed.scrollTop = myFeed.scrollHeight;
      });

      mySocket.on('myBroadcastSummary', (data) => {
        const myDiv = document.getElementById('myChatBox');
        myDiv.innerHTML += '<div style="background:#e8f0fe; padding:18px; border-left:6px solid #1a73e8; border-radius:6px; margin:10px 0; box-shadow:0 2px 5px rgba(0,0,0,0.05);"><b>✨ AI Brainstorm Synthesis:</b><br><br>' + data.text.replace(/\\n/g, '<br>') + '</div>';
        myDiv.scrollTop = myDiv.scrollHeight;
        myLockInput(data.wait);
      });

      mySocket.on('myPrivateTLDR', (txt) => { alert("ADMIN PRIVATE TL;DR:\\n\\n" + txt); });

      function mySend() {
        const myIn = document.getElementById('myMsg');
        if(myIn.value.trim()){ mySocket.emit('myUserChat', myIn.value); myIn.value = ''; }
      }

      function myGetSummary() { mySocket.emit('myTriggerSummary'); }
      function myGetTLDR() { mySocket.emit('myTriggerTLDR'); }

      function myLockInput(sec) {
        const myIn = document.getElementById('myMsg');
        const myBtn = document.getElementById('mySendBtn');
        const myTimer = document.getElementById('myTimer');
        myIn.disabled = myBtn.disabled = true;
        let myLeft = sec;
        const myInt = setInterval(() => {
          myTimer.innerText = "Review the AI Synthesis... (" + myLeft + "s)";
          if(myLeft-- <= 0) { clearInterval(myInt); myIn.disabled = myBtn.disabled = false; myTimer.innerText = ""; }
        }, 1000);
      }
    </script>
  </body>
  </html>
  `;
}

myServer.listen(process.env.PORT || 3000);

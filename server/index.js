const express = require('express');
const http = require('http');
const mediasoup = require('mediasoup');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

let worker;
const rooms = new Map();

(async () => {
  try {
    worker = await mediasoup.createWorker({
      rtcMinPort: 2000,
      rtcMaxPort: 2020,
    });
    console.log(`worker pid ${worker.pid}`);
  } catch (err) {
    console.error('Failed to create worker:', err);
  }
})();

const createRoom = async () => {
  const router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000
        }
      },
    ]
  });
  return {
    router,
    peers: new Map(),
    transports: new Map(),
    producers: new Map(),
    consumers: new Map()
  };
};

io.on('connection', async socket => {
  console.log('New client connected:', socket.id);

  socket.on('createRoom', async (callback) => {
    try {
      const roomId = uuidv4();
      const room = await createRoom();
      rooms.set(roomId, room);
      callback({ roomId });
    } catch (err) {
      console.error('Failed to create room:', err);
      callback({ error: err.message });
    }
  });

  socket.on('joinRoom', async ({ roomId }, callback) => {
    try {
      const room = rooms.get(roomId);
      if (!room) {
        return callback({ error: 'Room not found' });
      }

      room.peers.set(socket.id, {
        socket,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map()
      });

      socket.roomId = roomId;
      socket.join(roomId);
      callback({ rtpCapabilities: room.router.rtpCapabilities });

      // Notify other peers in the room
      socket.to(roomId).emit('peerJoined', { peerId: socket.id });

      // Inform the new peer about existing producers
      for (const [peerId, peer] of room.peers) {
        if (peerId !== socket.id) {
          for (const producer of peer.producers.values()) {
            socket.emit('newProducer', {
              producerId: producer.id,
              producerPeerId: peerId
            });
          }
        }
      }
    } catch (err) {
      console.error('Failed to join room:', err);
      callback({ error: err.message });
    }
  });

  socket.on('createWebRtcTransport', async ({ consumer }, callback) => {
    try {
      const room = rooms.get(socket.roomId);
      if (!room) {
        return callback({ error: 'Room not found' });
      }

      const transport = await createWebRtcTransport(room.router);
      room.transports.set(transport.id, transport);
      room.peers.get(socket.id).transports.set(transport.id, transport);

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        }
      });
    } catch (err) {
      console.error('Failed to create WebRTC transport:', err);
      callback({ error: err.message });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      const room = rooms.get(socket.roomId);
      if (!room) {
        return callback({ error: 'Room not found' });
      }

      const transport = room.transports.get(transportId);
      await transport.connect({ dtlsParameters });
      callback();
    } catch (err) {
      console.error('Failed to connect transport:', err);
      callback({ error: err.message });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    try {
      const room = rooms.get(socket.roomId);
      if (!room) {
        return callback({ error: 'Room not found' });
      }

      const transport = room.transports.get(transportId);
      const producer = await transport.produce({ kind, rtpParameters });
      room.producers.set(producer.id, producer);
      room.peers.get(socket.id).producers.set(producer.id, producer);

      callback({ id: producer.id });

      // Notify all peers in the room about the new producer
      for (const peer of room.peers.values()) {
        if (peer.socket.id !== socket.id) {
          peer.socket.emit('newProducer', {
            producerId: producer.id,
            producerPeerId: socket.id
          });
        }
      }
    } catch (err) {
      console.error('Failed to produce:', err);
      callback({ error: err.message });
    }
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    try {
      const room = rooms.get(socket.roomId);
      if (!room) {
        return callback({ error: 'Room not found' });
      }
  
      const transport = room.transports.get(transportId);
      const producer = room.producers.get(producerId);
  
      if (!producer) {
        return callback({ error: 'Producer not found' });
      }
  
      if (!room.router.canConsume({
        producerId: producer.id,
        rtpCapabilities,
      })) {
        return callback({ error: 'Cannot consume' });
      }
  
      const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true,
      });
  
      room.consumers.set(consumer.id, consumer);
      room.peers.get(socket.id).consumers.set(consumer.id, consumer);
  
      consumer.on('transportclose', () => {
        console.log('Consumer transport closed');
      });
  
      consumer.on('producerclose', () => {
        console.log('Producer of consumer closed');
        socket.emit('consumerClosed', { consumerId: consumer.id });
      });
  
      callback({
        id: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused
      });
    } catch (err) {
      console.error('Failed to consume:', err);
      callback({ error: err.message });
    }
  });
  
  socket.on('resumeConsumer', async ({ consumerId }, callback) => {
    try {
      const room = rooms.get(socket.roomId);
      if (!room) {
        return callback({ error: 'Room not found' });
      }

      const consumer = room.consumers.get(consumerId);
      await consumer.resume();
      callback();
    } catch (err) {
      console.error('Failed to resume consumer:', err);
      callback({ error: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const room = rooms.get(socket.roomId);
    if (room) {
      room.peers.get(socket.id)?.transports.forEach(transport => transport.close());
      room.peers.delete(socket.id);
      socket.to(socket.roomId).emit('peerLeft', { peerId: socket.id });
      if (room.peers.size === 0) {
        rooms.delete(socket.roomId);
      }
    }
  });
});

const createWebRtcTransport = async (router) => {
  try {
    const transport = await router.createWebRtcTransport({
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: '127.0.0.1', // replace with your public IP address
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });

    transport.on('dtlsstatechange', dtlsState => {
      if (dtlsState === 'closed') {
        console.log('Transport closed due to DTLS state change');
        transport.close();
      }
    });

    transport.on('close', () => {
      console.log('Transport closed');
    });

    return transport;
  } catch (err) {
    console.error('Failed to create WebRTC transport:', err);
    throw err;
  }
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
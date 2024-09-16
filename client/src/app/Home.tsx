'use client';

import React, { useState, useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
import { Device } from 'mediasoup-client'
import { MicOff, Mic } from 'lucide-react'

interface Peer {
  id: string;
  muted: boolean;
}

export default function Home() {
  const [isConnected, setIsConnected] = useState(false)
  const [roomId, setRoomId] = useState('')
  const [peers, setPeers] = useState<Peer[]>([])
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [joinRoomId, setJoinRoomId] = useState('')
  const [localMuted, setLocalMuted] = useState(false)
  const socketRef = useRef<Socket | null>(null)
  const deviceRef = useRef<Device | null>(null)
  const producerTransportRef = useRef<any>(null)
  const consumerTransportsRef = useRef<Map<string, any>>(new Map())
  const producersRef = useRef<Map<string, any>>(new Map())
  const consumersRef = useRef<Map<string, any>>(new Map())
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideosRef = useRef<Map<string, HTMLVideoElement>>(new Map())

  useEffect(() => {
    socketRef.current = io('http://localhost:4000')
    deviceRef.current = new Device()

    socketRef.current.on('connect', () => {
      console.log('Connected to server')
      setIsConnected(true)
    })

    socketRef.current.on('disconnect', () => {
      console.log('Disconnected from server')
      setIsConnected(false)
    })

    socketRef.current.on('peerJoined', ({ peerId, muted }) => {
      console.log('New peer joined:', peerId)
      setPeers(prevPeers => [...prevPeers, { id: peerId, muted }])
    })

    socketRef.current.on('peerLeft', ({ peerId }) => {
      console.log('Peer left:', peerId)
      setPeers(prevPeers => prevPeers.filter(peer => peer.id !== peerId))
      const consumerTransport = consumerTransportsRef.current.get(peerId)
      if (consumerTransport) {
        consumerTransport.close()
        consumerTransportsRef.current.delete(peerId)
      }
      const videoElement = remoteVideosRef.current.get(peerId)
      if (videoElement) {
        videoElement.srcObject = null
        remoteVideosRef.current.delete(peerId)
        videoElement.remove()
      }
    })

    socketRef.current.on('newProducer', async ({ producerId, producerPeerId, muted }) => {
      console.log('New producer available:', producerId, 'from peer:', producerPeerId)
      setPeers(prevPeers => prevPeers.map(peer => 
        peer.id === producerPeerId ? { ...peer, muted } : peer
      ))
      await consume(producerId, producerPeerId)
    })

    socketRef.current.on('consumerClosed', ({ consumerId }) => {
      console.log('Consumer closed:', consumerId)
      const consumer = consumersRef.current.get(consumerId)
      if (consumer) {
        consumer.close()
        consumersRef.current.delete(consumerId)
      }
    })

    socketRef.current.on('peerMuted', ({ peerId, muted }) => {
      setPeers(prevPeers => prevPeers.map(peer => 
        peer.id === peerId ? { ...peer, muted } : peer
      ))
    })

    return () => {
      console.log('Cleaning up...')
      socketRef.current?.disconnect()
      
      remoteVideosRef.current.forEach((videoElement, peerId) => {
        videoElement.srcObject = null
        videoElement.remove()
      })
      remoteVideosRef.current.clear()

      producerTransportRef.current?.close()
      consumerTransportsRef.current.forEach(transport => transport.close())
      consumerTransportsRef.current.clear()

      producersRef.current.forEach(producer => producer.close())
      producersRef.current.clear()
      consumersRef.current.forEach(consumer => consumer.close())
      consumersRef.current.clear()
    }
  }, [])

  const createRoom = async () => {
    try {
      const { roomId } = await new Promise<any>((resolve) =>
        socketRef.current?.emit('createRoom', resolve)
      )
      console.log('Room created:', roomId)
      setRoomId(roomId)
      await joinRoom(roomId)
    } catch (error) {
      console.error('Failed to create room:', error)
    }
  }

  const joinRoom = async (roomId: string) => {
    try {
      const { rtpCapabilities } = await new Promise<any>((resolve) =>
        socketRef.current?.emit('joinRoom', { roomId }, resolve)
      )
      console.log('Joined room:', roomId)
      setRoomId(roomId)
      await deviceRef.current?.load({ routerRtpCapabilities: rtpCapabilities })
      await produce()
    } catch (error) {
      console.error('Failed to join room:', error)
    }
  }

  const produce = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      setLocalStream(stream)
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }

      const params = await new Promise<any>((resolve) =>
        socketRef.current?.emit('createWebRtcTransport', { consumer: false }, resolve)
      )
      producerTransportRef.current = deviceRef.current?.createSendTransport(params.params)

      producerTransportRef.current.on('connect', ({ dtlsParameters }: any, callback: () => void) => {
        socketRef.current?.emit('connectTransport', {
          transportId: producerTransportRef.current.id,
          dtlsParameters
        }, callback)
      })

      producerTransportRef.current.on('produce', async ({ kind, rtpParameters }: any, callback: (arg0: { id: any }) => void) => {
        const { id } = await new Promise<any>(resolve =>
          socketRef.current?.emit('produce', {
            transportId: producerTransportRef.current.id,
            kind,
            rtpParameters
          }, resolve)
        )
        callback({ id })
      })

      const videoProducer = await producerTransportRef.current.produce({ track: stream.getVideoTracks()[0] })
      producersRef.current.set('video', videoProducer)

      const audioProducer = await producerTransportRef.current.produce({ track: stream.getAudioTracks()[0] })
      producersRef.current.set('audio', audioProducer)

      console.log('Production started')
    } catch (error) {
      console.error('Failed to produce:', error)
    }
  }

  const consume = async (producerId: string, producerPeerId: string) => {
    try {
      console.log(`Starting to consume producer ${producerId} from peer ${producerPeerId}`)

      const { params } = await new Promise<any>((resolve) =>
        socketRef.current?.emit('createWebRtcTransport', { consumer: true }, resolve)
      )
      console.log('Consumer transport created:', params)

      const consumerTransport = deviceRef.current?.createRecvTransport(params)
      if (!consumerTransport) {
        throw new Error('Failed to create consumer transport')
      }

      consumerTransportsRef.current.set(producerPeerId, consumerTransport)

      consumerTransport.on('connect', ({ dtlsParameters }: any, callback: () => void) => {
        console.log('Consumer transport connect event')
        socketRef.current?.emit('connectTransport', {
          transportId: consumerTransport.id,
          dtlsParameters
        }, callback)
      })

      const { id, kind, rtpParameters } = await new Promise<any>((resolve) =>
        socketRef.current?.emit('consume', {
          transportId: consumerTransport.id,
          producerId,
          rtpCapabilities: deviceRef.current?.rtpCapabilities
        }, resolve)
      )
      console.log('Consume parameters received:', { id, kind, rtpParameters })

      const consumer = await consumerTransport.consume({
        id,
        producerId,
        kind,
        rtpParameters
      })

      consumersRef.current.set(consumer.id, consumer)

      const { track } = consumer
      if (track) {
        console.log('Received remote track:', track)
        const remoteStream = new MediaStream([track])
        const videoElement = document.createElement('video')
        videoElement.srcObject = remoteStream
        videoElement.autoplay = true
        videoElement.playsInline = true
        remoteVideosRef.current.set(producerPeerId, videoElement)
        const remoteVideosContainer = document.getElementById('remoteVideos')
        if (remoteVideosContainer) {
          const videoWrapper = document.createElement('div')
          videoWrapper.className = 'relative aspect-video'
          videoWrapper.appendChild(videoElement)
          remoteVideosContainer.appendChild(videoWrapper)
          console.log('Remote video element added to DOM')
        } else {
          console.error('Remote videos container not found')
        }
      } else {
        console.error('No track received from consumer')
      }

      await new Promise<void>((resolve) =>
        socketRef.current?.emit('resumeConsumer', { consumerId: consumer.id }, () => resolve())
      )
      console.log('Consumer resumed')

    } catch (error) {
      console.error('Failed to consume:', error)
    }
  }

  const toggleLocalMute = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0]
      audioTrack.enabled = !audioTrack.enabled
      setLocalMuted(!audioTrack.enabled)
      socketRef.current?.emit('toggleMute', { muted: !audioTrack.enabled })
    }
  }

  const toggleRemotePeerMute = (peerId: string) => {
    socketRef.current?.emit('toggleRemotePeerMute', { peerId })
  }

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      <header className="bg-blue-600 text-white p-4">
        <h1 className="text-2xl font-bold">Multi-user Video Calling App</h1>
      </header>

      <div className="flex-none p-4 bg-white shadow">
        <div className="flex items-center space-x-4">
          <button
            className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
            onClick={createRoom}
          >
            Create Room
          </button>
          <input
            type="text"
            value={joinRoomId}
            onChange={(e) => setJoinRoomId(e.target.value)}
            placeholder="Enter Room ID"
            className="border rounded py-2 px-4 flex-grow"
          />
          <button
            className="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded"
            onClick={() => joinRoom(joinRoomId)}
          >
            Join Room
          </button>
        </div>
        <div className="mt-2 text-sm text-gray-600">
          <p>Connection status: {isConnected ? 'Connected' : 'Disconnected'}</p>
          <p>Room ID: {roomId || 'Not in a room'}</p>
          <p>Number of peers: {peers.length}</p>
        </div>
      </div>

      <div className="flex-grow p-4 overflow-y-auto">
        <div id="remoteVideos" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {peers.map((peer) => (
            <div key={peer.id} className="relative aspect-video">
              <video
                ref={(el) => {
                  if (el) remoteVideosRef.current.set(peer.id, el)
                }}
                autoPlay
                playsInline
                className="w-full h-full object-cover rounded-lg shadow-lg"
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <button
                  onClick={() => toggleRemotePeerMute(peer.id)}
                  className="bg-black bg-opacity-50 rounded-full p-2"
                >
                  {peer.muted ? <MicOff className="text-white w-6 h-6" /> : <Mic className="text-white w-6 h-6" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-none p-4 bg-gray-200">
        <div className="relative w-48 h-36 mx-auto">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover rounded-lg shadow-lg"
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <button
              onClick={toggleLocalMute}
              className="bg-black bg-opacity-50 rounded-full p-2"
            >
              {localMuted ? <MicOff className="text-white w-6 h-6" /> : <Mic className="text-white w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

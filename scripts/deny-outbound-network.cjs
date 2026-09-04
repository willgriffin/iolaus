'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const denial = () => {
  throw new Error(
    'Outbound networking is disabled by the deployed parity contract.',
  );
};

const isLocalIpc = (args) => {
  const destination = args[0];
  return (
    (Array.isArray(destination) && isLocalIpc(destination)) ||
    typeof destination === 'string' ||
    (destination &&
      typeof destination === 'object' &&
      typeof destination.path === 'string')
  );
};
const originalConnect = net.connect;
const originalCreateConnection = net.createConnection;
const originalSocketConnect = net.Socket.prototype.connect;

net.connect = (...args) =>
  isLocalIpc(args) ? originalConnect(...args) : denial();
net.createConnection = (...args) =>
  isLocalIpc(args) ? originalCreateConnection(...args) : denial();
net.Socket.prototype.connect = function connect(...args) {
  return isLocalIpc(args) ? originalSocketConnect.apply(this, args) : denial();
};
http.request = denial;
http.get = denial;
https.request = denial;
https.get = denial;
globalThis.fetch = denial;

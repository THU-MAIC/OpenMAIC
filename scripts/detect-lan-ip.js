#!/usr/bin/env node
const os = require('os');

function isPrivateIP(ip) {
  // 内网IP范围：
  // 10.0.0.0/8
  // 172.16.0.0/12
  // 192.168.0.0/16
  const octets = ip.split('.').map(Number);
  
  if (octets[0] === 10) {
    return true;
  }
  
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return true;
  }
  
  if (octets[0] === 192 && octets[1] === 168) {
    return true;
  }
  
  return false;
}

function getPrivateIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal && isPrivateIP(addr.address)) {
        ips.push(addr.address);
      }
    }
  }
  
  return ips;
}

const ips = getPrivateIPs();
console.log(ips.join(' '));

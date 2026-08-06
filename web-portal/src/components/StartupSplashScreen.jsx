import React from 'react';

export default function StartupSplashScreen() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: '#030a13',
      color: '#0891b2',
      fontFamily: 'monospace',
      fontSize: '12px',
      letterSpacing: '0.2em',
    }}>
      <div style={{
        fontSize: '24px',
        fontWeight: 'bold',
        letterSpacing: '0.3em',
        color: '#22d3ee',
        marginBottom: '8px',
        animation: 'pulse 2s infinite',
      }}>
        SPECTERCOMS
      </div>
      <div>RESTORING SESSION...</div>
    </div>
  );
}

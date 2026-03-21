<?php
// Simple QR Code Generator for OTP
// Based on PHP QR Code library by Dominik Dzienia

class QRCode {
    private $qrCodeData;
    
    public function __construct() {
        // Initialize QR code data structure
        $this->qrCodeData = array();
    }
    
    public function getQRCode($text, $size = 10) {
        // Simple implementation that returns a basic QR code representation
        // In a real implementation, this would generate actual QR code images
        return $this->generateSimpleQR($text, $size);
    }
    
    private function generateSimpleQR($text, $size) {
        // This is a placeholder - in reality we'd use a proper QR library
        // For now we'll create a simple text representation
        
        // Create a basic QR code URI format for OTP
        $uri = "otpauth://totp/" . urlencode($text);
        
        // Return the URI that can be used to generate actual QR codes
        return $uri;
    }
    
    // Generate proper OTP URI for authenticator apps
    public function getOTPURI($user_id, $secret, $issuer = "AuthSystem") {
        $uri = "otpauth://totp/" . urlencode($issuer) . ":" . urlencode($user_id);
        $uri .= "?secret=" . urlencode($secret);
        $uri .= "&issuer=" . urlencode($issuer);
        $uri .= "&algorithm=SHA1";
        $uri .= "&digits=6";
        $uri .= "&period=30";
        
        return $uri;
    }
}

// Simple function to generate QR code URL for OTP
function generate_otp_qr_url($user_id, $secret, $issuer = "AuthSystem") {
    $uri = "otpauth://totp/" . urlencode($issuer) . ":" . urlencode($user_id);
    $uri .= "?secret=" . urlencode($secret);
    $uri .= "&issuer=" . urlencode($issuer);
    $uri .= "&algorithm=SHA1";
    $uri .= "&digits=6";
    $uri .= "&period=30";
    
    return $uri;
}
?>
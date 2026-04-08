const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  // Fix #1: Fail-fast jika JWT_SECRET tidak di-set
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error("[SECURITY] JWT_SECRET tidak di-set di environment!");
    return res.status(500).json({
      success: false,
      message: "Konfigurasi server tidak lengkap. Hubungi administrator.",
    });
  }

  try {
    const authHeader = req.headers.authorization || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: token tidak ditemukan",
      });
    }

    const decoded = jwt.verify(token, secret);

    req.user = {
      consignor_id: decoded.consignor_id,
      phone: decoded.phone,
      email: decoded.email,
      full_name: decoded.full_name,
    };

    return next();
  } catch {
    // Fix #6: Tidak expose detail error ke client
    return res.status(401).json({
      success: false,
      message: "Unauthorized: token tidak valid atau sudah kedaluwarsa",
    });
  }
}

module.exports = { requireAuth };

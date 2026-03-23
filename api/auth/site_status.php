<?php
session_start();
require_once dirname(__DIR__) . '/common.php';

jsonResponse(['authenticated' => isset($_SESSION['site_auth']) && $_SESSION['site_auth'] === true]);

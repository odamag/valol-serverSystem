<?php
session_start();
require_once dirname(__DIR__) . '/common.php';

session_destroy();
jsonResponse(['success' => true]);
